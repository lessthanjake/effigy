#!/usr/bin/env node
/**
 * effigy — a headed browser that remembers who you are.
 *
 * ## Why this exists
 *
 * The Playwright MCP `--extension` bridge drives your real Chrome through a
 * websocket relay whose port is reassigned every time the MCP server restarts.
 * The extension keeps pointing at the dead port, so mid-automation every call
 * dies with "Target page, context or browser has been closed" and only a manual
 * Chrome-side re-handshake (extension icon -> Connect) revives it. Fine for one
 * action; unusable across a multi-step flow.
 *
 * effigy removes the relay from the picture. It launches its *own* headed
 * Chromium against a dedicated, persistent user-data-dir, and exposes it on a
 * fixed CDP port. Log that profile into a site once — Phala, a testnet faucet,
 * Rabby — and every later run inherits the session. Nothing to re-handshake,
 * no port to go stale, no fight with the daily-driver Chrome profile (which is
 * locked by the running Chrome and must never be used here).
 *
 * The daemon holds the body; each command is a short-lived CDP client that
 * steps in, acts, and steps out. Between commands the window just sits there,
 * logged in, visible to you.
 *
 * ## The one thing it will not do
 *
 * effigy never touches wallet UI. It refuses to click or type into any
 * `chrome-extension://` page. The agent drives the dapp and may initiate a
 * transaction; the Rabby popup is yours to sign or reject. That rule is
 * enforced in code (see `assertNotWalletUI`), not just in a comment.
 *
 * ## Usage
 *
 *   effigy up [--profile NAME] [--port N] [--channel chrome] [--no-rabby]
 *   effigy setup                       one-time: opens Rabby + prints checklist
 *   effigy status | tabs | down
 *   effigy goto <url> [--new] [--wait-for SEL] [--tab N]
 *   effigy shot <out.png> [--full] [--tab N]
 *   effigy text [--selector SEL] [--tab N]
 *   effigy click <"TEXT"|--selector SEL> [--tab N]
 *   effigy type --selector SEL <text> [--enter] [--tab N]
 *   effigy press <Key> [--tab N]
 *   effigy eval <js> [--tab N]
 *   effigy wait <ms|selector> [--tab N]
 *   effigy console [--n 40] [--clear]
 *   effigy net [--n 40] [--clear]
 *   effigy close [--tab N]
 *   effigy run <script.mjs>            default export: async ({ context, page }) => {}
 *
 * Profiles live in ~/.effigy/profiles/<name> and are never committed anywhere.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const ROOT = path.join(HOME, ".effigy");
const DEFAULT_PORT = 9333;
const RABBY_ID = "acmacodkjbdgmoleebolmdjonilkdbch";

// ---------------------------------------------------------------- arg parsing

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name, dflt = undefined) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);
/** Positional args, minus the command and any `--flag value` pairs. */
const positional = () => {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (argv[i + 1] && !argv[i + 1].startsWith("--") && VALUED_FLAGS.has(argv[i].slice(2))) i++;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
};
const VALUED_FLAGS = new Set(["profile", "port", "channel", "tab", "selector", "wait-for", "n", "timeout", "as", "window-size", "browser", "from", "to"]);

/**
 * Who is asking. You may run many agent sessions at once, and any of them may
 * want a browser — that concurrency is the whole reason the MCP extension bridge
 * failed (one extension, N relays, last-connect wins). effigy resolves it at the
 * tab level instead: every session leases its own tab in the shared window, so
 * two agents can drive the same logged-in profile without stealing each other's
 * page. `CLAUDE_CODE_SESSION_ID` is present in every command's environment, so
 * this needs no flag and no discipline from you.
 */
const SESSION =
  flag("as") ||
  process.env.EFFIGY_LEASE ||
  (process.env.CLAUDE_CODE_SESSION_ID ? "s" + process.env.CLAUDE_CODE_SESSION_ID.replace(/-/g, "").slice(0, 8) : null) ||
  `pid${process.ppid}`;

/**
 * Profile resolution, most specific first:
 *   --profile NAME     explicit wins, always
 *   --ephemeral        a throwaway identity for this session, deleted on `down`
 *   EFFIGY_PROFILE     the shell's standing choice
 *   eph-<session> up   this session already booted an ephemeral window — stay in
 *                      it, so `--ephemeral` is a thing you say once, not on
 *                      every command
 *   default
 */
const PROFILE = (() => {
  const explicit = flag("profile");
  if (explicit) return explicit;
  if (has("ephemeral")) return `eph-${SESSION}`;
  if (process.env.EFFIGY_PROFILE) return process.env.EFFIGY_PROFILE;
  if (fs.existsSync(path.join(ROOT, "state", `eph-${SESSION}.json`))) return `eph-${SESSION}`;
  return "default";
})();
const paths = {
  profile: path.join(ROOT, "profiles", PROFILE),
  state: path.join(ROOT, "state", `${PROFILE}.json`),
  leases: path.join(ROOT, "state", `${PROFILE}.leases`),
  logs: path.join(ROOT, "logs", PROFILE),
  extensions: path.join(ROOT, "extensions"),
};
const logFile = (name) => path.join(paths.logs, name);

const die = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

// ------------------------------------------------------------- state helpers

const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(paths.state, "utf8"));
  } catch {
    return null;
  }
};
const writeState = (s) => {
  fs.mkdirSync(path.dirname(paths.state), { recursive: true });
  fs.writeFileSync(paths.state, JSON.stringify(s, null, 2));
};
const clearState = () => fs.rmSync(paths.state, { force: true });

const cdpAlive = async (port, ms = 800) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(ms),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

/** Resolve a live daemon, or exit with instructions. */
const requireLive = async () => {
  const state = readState();
  if (!state) die(`effigy: no daemon for profile "${PROFILE}". Start one: effigy up`);
  const info = await cdpAlive(state.port);
  if (!info) {
    clearState();
    die(
      `effigy: daemon for "${PROFILE}" is gone (port ${state.port} dead — window closed?).\n` +
        `        Start a new one: effigy up --profile ${PROFILE}`,
    );
  }
  return { state, info };
};

// ------------------------------------------------------------------ up: boot

/**
 * Rabby ships to the real Chrome profile as a versioned unpacked directory. We
 * copy the newest one into ~/.effigy/extensions so the automation profile gets
 * the *code* without ever reading from (or locking) the live Chrome profile.
 *
 * The copy carries no keys — a freshly loaded Rabby is an empty wallet. You
 * import a wallet into it once, by hand, in the headed window. Use a wallet
 * you would be comfortable losing: this profile sits unencrypted on disk and
 * an agent drives the pages next to it.
 */
const stageRabby = async () => {
  const roots = ["Default", "Profile 1", "Profile 2", "Profile 3"]
    .map((p) => path.join(HOME, "Library/Application Support/Google/Chrome", p, "Extensions", RABBY_ID))
    .filter((p) => fs.existsSync(p));
  if (!roots.length) return null;
  let best = null;
  for (const root of roots) {
    for (const v of await fsp.readdir(root)) {
      if (!fs.existsSync(path.join(root, v, "manifest.json"))) continue;
      const key = v.split("_")[0].split(".").map(Number);
      if (!best || cmpVersion(key, best.key) > 0) best = { key, dir: path.join(root, v), v };
    }
  }
  if (!best) return null;
  const dest = path.join(paths.extensions, `rabby-${best.v}`);
  if (!fs.existsSync(path.join(dest, "manifest.json"))) {
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.cp(best.dir, dest, { recursive: true });
    // `_metadata` is the web-store signature; it is meaningless unpacked and
    // Chromium warns about it, so drop it.
    await fsp.rm(path.join(dest, "_metadata"), { recursive: true, force: true });
  }
  return dest;
};
const cmpVersion = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

// ------------------------------------------------------------------- cloning

const CHROME_ROOT = path.join(HOME, "Library/Application Support/Google/Chrome");

/**
 * Chromium-family browsers a profile can be cloned from. Each keeps its cookie key
 * in the login Keychain under its own "<Name> Safe Storage" item, and only that
 * browser's binary is on the item's ACL — so a clone must be launched with the
 * SAME binary it came from (Chrome via Playwright's `channel`, others via
 * `executablePath`). `up` reads `browser` from the clone marker and does this.
 */
const BROWSERS = {
  chrome: { root: CHROME_ROOT, exe: null, label: "Chrome" },
  brave: {
    root: path.join(HOME, "Library/Application Support/BraveSoftware/Brave-Browser"),
    exe: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    label: "Brave",
  },
  edge: {
    root: path.join(HOME, "Library/Application Support/Microsoft Edge"),
    exe: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    label: "Edge",
  },
};
const readCloneMarker = (profileDir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(profileDir, ".effigy-clone.json"), "utf8"));
  } catch {
    return null;
  }
};

/**
 * What NOT to carry over from a real Chrome profile.
 *
 * Two kinds of exclusion, and the distinction matters:
 *
 *   caches — pure bulk. A profile is mostly cache; none of it is session state,
 *   and copying it turns a 200MB clone into a 5GB one.
 *
 *   credentials we don't need — "Login Data" is the saved-password store and
 *   "Web Data" holds autofill including card numbers. Cloning a *logged-in*
 *   browser needs neither: the cookies already carry the sessions. Copying them
 *   would put your password vault in a second place on disk to buy nothing,
 *   so the clone deliberately leaves them behind.
 */
const CLONE_SKIP = [
  "Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache",
  "Media Cache", "Application Cache", "Service Worker/CacheStorage", "Service Worker/ScriptCache",
  "component_crx_cache", "optimization_guide", "Safe Browsing", "Segmentation Platform",
  "blob_storage", "Crashpad", "ShaderCache", "GrShaderCache", "Download Service",
  "Login Data", "Login Data For Account", "Web Data", "AutofillStrikeDatabase",
  "History", "Favicons", "Top Sites", "Visited Links", "Network Action Predictor",
  // Bulk with no bearing on being logged in. "Sessions" is also actively unwanted:
  // it would restore your real open tabs into the automation window.
  "shared_proto_db", "Sessions", "Conversions", "Site Characteristics Database",
];
const skipEntry = (rel) => CLONE_SKIP.some((s) => rel === s || rel.startsWith(`${s}/`) || rel.startsWith(`${s}-`));

const dirSize = (dir) => {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  };
  try {
    walk(dir);
  } catch {
    /* best effort */
  }
  return total;
};
const mb = (bytes) => `${(bytes / 1e6).toFixed(0)}MB`;

/**
 * Copy a live SQLite file consistently. Chrome is running while we clone, so a
 * plain `cp` of Cookies can catch a half-written page; `.backup` takes a proper
 * snapshot through SQLite's own locking.
 */
const copySqlite = async (src, dst) => {
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("/usr/bin/sqlite3", [src, `.backup '${dst}'`], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
};
const SQLITE_FILES = new Set(["Cookies", "Network/Cookies", "Affiliation Database", "Trust Tokens"]);

/** Warn (don't kill) when the other headed stack is up — they fight over CDP. */
const collisionWarning = async () => {
  const { execSync } = await import("node:child_process");
  try {
    const ps = execSync("ps -Ao command= 2>/dev/null || true", { encoding: "utf8" });
    if (ps.includes("gstack/browse/src/server.ts")) {
      console.error(
        "warning: the gstack /browse daemon is running. It lingers and fights other\n" +
          "         CDP clients. Tear it down first:  pkill -f 'gstack/browse/src/server.ts'",
      );
    }
  } catch {
    /* ps is best-effort */
  }
};

/** First port at or above `start` that nothing is listening on. */
const freePort = async (start) => {
  const net = await import("node:net");
  for (let p = start; p < start + 100; p++) {
    const open = await new Promise((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.once("listening", () => s.close(() => resolve(true)));
      s.listen(p, "127.0.0.1");
    });
    if (open) return p;
  }
  die(`effigy: no free port in ${start}..${start + 100}`);
};

const up = async () => {
  const existing = readState();
  if (existing) {
    const info = await cdpAlive(existing.port);
    if (info) {
      console.log(`already up: profile=${PROFILE} port=${existing.port} pid=${existing.pid}`);
      return;
    }
    clearState();
  }

  // Two sessions can call `up` on the same profile in the same second. Chrome
  // locks a user-data-dir to one process, so the loser would crash on launch —
  // instead it waits for the winner's window and joins it.
  fs.mkdirSync(path.dirname(paths.state), { recursive: true });
  const lock = `${paths.state}.lock`;
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
  } catch {
    for (let i = 0; i < 200; i++) {
      const s = readState();
      if (s?.port && (await cdpAlive(s.port))) {
        console.log(`already up: profile=${PROFILE} port=${s.port} pid=${s.pid} (booted by another session)`);
        return;
      }
      await sleep(250);
    }
    fs.rmSync(lock, { force: true }); // the other side died mid-boot; take over
    return up();
  }
  const releaseLock = () => fs.rmSync(lock, { force: true });
  process.on("exit", releaseLock);

  // Ports are allocated, not assigned: N profiles across N sessions must never
  // have to coordinate on a number.
  const port = flag("port")
    ? Number(flag("port"))
    : await freePort(Number(process.env.EFFIGY_PORT || DEFAULT_PORT));
  await collisionWarning();

  fs.mkdirSync(paths.logs, { recursive: true });
  const out = fs.openSync(logFile("daemon.log"), "a");
  const child = spawn(
    process.execPath,
    [import.meta.filename, "__daemon", "--profile", PROFILE, "--port", String(port), ...passthrough()],
    { detached: true, stdio: ["ignore", out, out] },
  );
  child.unref();
  // Detached, but we still hold the handle for as long as this process lives —
  // so a daemon that dies on launch (profile lock, bad --channel) reports the
  // real reason instead of making the caller wait out the timeout.
  let died = null;
  child.on("exit", (code) => (died = code));

  // The daemon writes state only once the browser is actually serving CDP.
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (died !== null) {
      const log = fs.existsSync(logFile("daemon.log"))
        ? fs.readFileSync(logFile("daemon.log"), "utf8").trim().split("\n").slice(-8).join("\n")
        : "(no log)";
      die(`effigy: daemon exited immediately (code ${died}).\n${log}`);
    }
    const s = readState();
    if (s?.port && (await cdpAlive(s.port))) {
      console.log(`up: profile=${PROFILE} port=${s.port} pid=${s.pid} profileDir=${paths.profile}`);
      if (s.cloned) console.log(`cloned profile: real ${BROWSERS[readCloneMarker(paths.profile)?.browser || "chrome"]?.label ?? "Chrome"} binary, your own extensions and sessions`);
      else if (s.rabby) console.log(`rabby: loaded from ${s.rabby}`);
      else console.log("rabby: not loaded (no Rabby found in Chrome, or --no-rabby)");
      return;
    }
    await sleep(250);
  }
  die(`effigy: daemon did not come up in 45s. Log: ${logFile("daemon.log")}`);
};
/** Flags that must survive the re-spawn into the daemon process. */
const passthrough = () =>
  ["channel", "window-size"].flatMap((f) => (flag(f) ? [`--${f}`, flag(f)] : [])).concat(has("no-rabby") ? ["--no-rabby"] : []);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------- the daemon

const daemon = async () => {
  const port = Number(flag("port", DEFAULT_PORT));
  fs.mkdirSync(paths.logs, { recursive: true });
  fs.mkdirSync(paths.profile, { recursive: true });

  // A cloned profile already carries your real extensions (Rabby included,
  // with his vault), and its cookies only decrypt under the real Chrome binary
  // — see `clone`. So: real Chrome, and no unpacked Rabby to bolt on.
  const marker = readCloneMarker(paths.profile);
  const cloned = !!marker;
  const browser = BROWSERS[marker?.browser || "chrome"] || BROWSERS.chrome;
  const rabby = has("no-rabby") || cloned ? null : await stageRabby().catch(() => null);
  const [w, h] = (flag("window-size", "1440,960") || "1440,960").split(",");

  const args = [
    `--remote-debugging-port=${port}`,
    `--window-size=${w},${h}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  // Loading Rabby *without* --disable-extensions-except so that anything you
  // install from the Web Store into this profile keeps working too.
  if (rabby) args.push(`--load-extension=${rabby}`);

  const context = await chromium.launchPersistentContext(paths.profile, {
    headless: false,
    // A clone launches with the binary it was cloned from (see BROWSERS): Chrome via
    // channel, Brave/Edge via executablePath (Playwright allows only one of the two).
    ...(cloned && browser.exe
      ? { executablePath: browser.exe }
      : { channel: flag("channel") || (cloned ? "chrome" : undefined) }),
    args,
    viewport: null, // let the real window size govern
    ignoreDefaultArgs: [
      // Drops the "controlled by automated software" tell that some login
      // flows score against you.
      "--enable-automation",
      // Playwright hands Chromium `--disable-extensions` by default, which
      // silently beats `--load-extension`: the browser comes up looking fine
      // and Rabby simply is not there (chrome-extension:// URLs return
      // ERR_BLOCKED_BY_CLIENT). Both of these have to go for a wallet to load.
      "--disable-extensions",
      "--disable-component-extensions-with-background-pages",
      // Playwright also passes `--use-mock-keychain`, which is right for a throwaway
      // profile and catastrophic for a cloned one: macOS cookie values are encrypted
      // with a key in the login Keychain, the mock keychain returns the wrong key,
      // and Chrome's response to cookies it cannot decrypt is to DELETE them. A clone
      // launched with it comes up looking fine and silently loses every session on
      // first run — 3701 cookies down to 8, which is how this was found.
      ...(cloned ? ["--use-mock-keychain"] : []),
    ],
  });

  wireLogging(context);

  writeState({
    profile: PROFILE,
    port,
    pid: process.pid,
    profileDir: paths.profile,
    rabby,
    cloned,
    startedAt: new Date().toISOString(),
  });
  console.log(`[daemon] up on ${port} (pid ${process.pid})`);

  // A page's beforeunload dialog (X's "leave page?" on a composer with text)
  // can be answered by a connected client and by this daemon at once; the
  // loser's Page.handleJavaScriptDialog rejects with "No dialog is showing"
  // as an unhandled rejection, which killed the daemon and closed the window
  // every time (2026-09-20). Log it and keep the window.
  process.on("unhandledRejection", (err) => {
    console.error("[daemon] unhandled rejection (kept alive):", err?.message ?? err);
  });

  // When you close the window, the context closes — tear the state down so
  // the next command says "start one" instead of timing out on a dead port.
  const bye = async () => {
    clearState();
    process.exit(0);
  };
  context.on("close", bye);
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
};

/**
 * Console + network capture. Agents cannot watch a window, so the daemon keeps
 * a rolling JSONL of everything the pages said while nobody was connected.
 */
const wireLogging = (context) => {
  const append = (file, row) => {
    try {
      fs.appendFileSync(logFile(file), JSON.stringify({ t: new Date().toISOString(), ...row }) + "\n");
    } catch {
      /* logging must never take the daemon down */
    }
  };
  const attach = (page) => {
    const where = () => page.url();
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning")
        append("console.jsonl", { level: m.type(), text: m.text(), url: where() });
    });
    page.on("pageerror", (e) => append("console.jsonl", { level: "pageerror", text: String(e), url: where() }));
    page.on("requestfailed", (r) =>
      append("net.jsonl", { kind: "failed", url: r.url(), error: r.failure()?.errorText }),
    );
    page.on("response", (r) => {
      if (r.status() >= 400) append("net.jsonl", { kind: "http", status: r.status(), url: r.url() });
    });
  };
  context.pages().forEach(attach);
  context.on("page", attach);
};

// ------------------------------------------------------------- CDP clients

/** Connect, hand the caller the context, then detach without killing anything. */
const withContext = async (fn) => {
  const { state } = await requireLive();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.port}`);
  try {
    const context = browser.contexts()[0];
    return await fn(context, state);
  } finally {
    // For a CDP *connection* this detaches only — the daemon's browser lives on.
    await browser.close().catch(() => {});
  }
};

const isWalletUI = (url) => url.startsWith("chrome-extension://") || url.startsWith("devtools://");

/** Enforced, not advisory: the agent drives the dapp, you sign the popup. */
const assertNotWalletUI = (page) => {
  if (isWalletUI(page.url()))
    die(
      "effigy: refusing to interact with wallet/extension UI.\n" +
        "        The agent drives the dapp; you sign or reject the popup by hand.\n" +
        "        (Read-only inspection is fine: `effigy shot --tab N` / `effigy text --tab N`.)",
    );
};

// ----------------------------------------------------------------- tab leases

const leaseFile = (key) => path.join(paths.leases, `${key}.json`);
const readLease = (key = SESSION) => {
  try {
    return JSON.parse(fs.readFileSync(leaseFile(key), "utf8"));
  } catch {
    return null;
  }
};
/** One file per session — concurrent sessions never write the same file. */
const writeLease = (key, data) => {
  fs.mkdirSync(paths.leases, { recursive: true });
  fs.writeFileSync(leaseFile(key), JSON.stringify(data, null, 2));
};
const allLeases = () => {
  try {
    return fs
      .readdirSync(paths.leases)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ key: f.replace(/\.json$/, ""), ...JSON.parse(fs.readFileSync(path.join(paths.leases, f), "utf8")) }));
  } catch {
    return [];
  }
};

/**
 * A tab's identity has to survive navigation, reordering, and other sessions
 * opening and closing tabs around it — so leases key on the CDP targetId, not
 * on an index into `context.pages()`.
 */
const targetIdOf = async (context, page) => {
  const cdp = await context.newCDPSession(page);
  try {
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    return targetInfo.targetId;
  } finally {
    await cdp.detach().catch(() => {});
  }
};
const pageByTarget = async (context, targetId) => {
  for (const p of context.pages()) {
    if (p.isClosed()) continue;
    if ((await targetIdOf(context, p).catch(() => null)) === targetId) return p;
  }
  return null;
};

/** Open this session's tab and label it, so you can see who owns what. */
const claimPage = async (context) => {
  const page = await context.newPage();
  writeLease(SESSION, { targetId: await targetIdOf(context, page), claimedAt: new Date().toISOString() });
  await page
    .evaluate((s) => {
      document.title = `effigy · ${s} · idle`;
      document.body.innerHTML =
        `<pre style="font:14px ui-monospace,monospace;color:#888;padding:2rem">effigy tab leased by session ${s}</pre>`;
    }, SESSION)
    .catch(() => {});
  return page;
};

/**
 * Which page a command acts on: this session's leased tab, claimed on first use
 * and re-claimed if it was closed. You may run many sessions at once; without the
 * lease, session A's `goto` would yank the page session B was mid-read on.
 *
 * `--tab N` indexes the `effigy tabs` listing exactly, for deliberately looking
 * at someone else's tab (or the wallet's).
 */
const pickPage = async (context) => {
  const n = flag("tab");
  if (n !== undefined) {
    const p = context.pages()[Number(n)];
    if (!p) die(`effigy: no tab ${n} (see: effigy tabs)`);
    return p;
  }
  const lease = readLease();
  if (lease) {
    const p = await pageByTarget(context, lease.targetId);
    if (p) return p;
  }
  return claimPage(context);
};

const commands = {
  up,
  __daemon: daemon,

  async down() {
    const state = readState();
    // Shared profiles are shared: taking the window down takes every other
    // session's tab with it, so say so rather than doing it silently.
    const others = allLeases().filter((l) => l.key !== SESSION);
    if (others.length && !has("force"))
      die(
        `effigy: ${others.length} other session(s) hold tabs on "${PROFILE}" (${others.map((l) => l.key).join(", ")}).\n` +
          `        \`effigy release\` gives up just your tab. \`effigy down --force\` closes the window on everyone.`,
      );
    if (!state) return console.log(`down: nothing running for "${PROFILE}"`);
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 20 && (await cdpAlive(state.port, 300)); i++) await sleep(150);
    clearState();
    fs.rmSync(paths.leases, { recursive: true, force: true });
    // An ephemeral profile is a costume, not an identity — burn it on the way out.
    if (PROFILE.startsWith("eph-")) {
      fs.rmSync(paths.profile, { recursive: true, force: true });
      console.log(`down: profile=${PROFILE} (ephemeral — profile deleted)`);
      return;
    }
    console.log(`down: profile=${PROFILE}`);
  },

  async status() {
    const state = readState();
    if (!state) return console.log(`status: down (profile=${PROFILE})`);
    const info = await cdpAlive(state.port);
    if (!info) {
      clearState();
      return console.log(`status: down — stale state cleared (port ${state.port} dead)`);
    }
    console.log(
      [
        `status: up`,
        `profile:  ${state.profile}  (${state.profileDir})`,
        `cdp:      http://127.0.0.1:${state.port}`,
        `browser:  ${info.Browser}`,
        `pid:      ${state.pid}`,
        `since:    ${state.startedAt}`,
        `rabby:    ${state.rabby ?? (state.cloned ? "from the cloned profile" : "not loaded")}`,
        ...(() => {
          try {
            const m = JSON.parse(fs.readFileSync(path.join(paths.profile, ".effigy-clone.json"), "utf8"));
            const days = Math.floor((Date.now() - new Date(m.at).getTime()) / 86_400_000);
            return [`clone:    from Chrome "${m.from}", ${days}d old${days >= 14 ? " — sessions may have aged out; `effigy clone --force` to re-take" : ""}`];
          } catch {
            return [];
          }
        })(),
        `session:  ${SESSION}${readLease() ? " (holds a tab)" : " (no tab yet)"}`,
      ].join("\n"),
    );
    await commands.tabs();
  },

  async tabs() {
    await withContext(async (context) => {
      const pages = context.pages();
      if (!pages.length) return console.log("tabs: none");
      const owners = new Map(allLeases().map((l) => [l.targetId, l.key]));
      const rows = await Promise.all(
        pages.map(async (p, i) => {
          const owner = owners.get(await targetIdOf(context, p).catch(() => null));
          const tag = isWalletUI(p.url()) ? "(wallet ui) " : owner ? `<${owner}${owner === SESSION ? " — you" : ""}> ` : "";
          return `  [${i}] ${tag}${await p.title().catch(() => "")} — ${p.url()}`;
        }),
      );
      console.log("tabs:\n" + rows.join("\n"));
    });
  },

  /** Explicitly take a tab (pickPage does it lazily; this makes it visible). */
  async claim() {
    await withContext(async (context) => {
      const lease = readLease();
      const existing = lease && (await pageByTarget(context, lease.targetId));
      if (existing) return console.log(`claim: session ${SESSION} already holds a tab — ${existing.url()}`);
      await claimPage(context);
      console.log(`claim: session ${SESSION} took a new tab`);
    });
  },

  /** Give the tab back. Politeness, and it keeps the window from filling up. */
  async release() {
    const lease = readLease();
    if (!lease) return console.log(`release: session ${SESSION} holds no tab`);
    await withContext(async (context) => {
      const page = await pageByTarget(context, lease.targetId);
      // Never close the last tab: that closes the window and takes the daemon
      // (and every other session's browser) down with it.
      if (page && context.pages().length > 1) await page.close().catch(() => {});
      else if (page) await page.goto("about:blank").catch(() => {});
    });
    fs.rmSync(leaseFile(SESSION), { force: true });
    console.log(`release: session ${SESSION} let go of its tab`);
  },

  async leases() {
    const rows = allLeases();
    if (!rows.length) return console.log(`leases: none on profile "${PROFILE}"`);
    await withContext(async (context) => {
      const out = [];
      for (const l of rows) {
        const page = await pageByTarget(context, l.targetId);
        out.push(
          `  ${l.key}${l.key === SESSION ? " (you)" : ""}  ${page ? await page.title().catch(() => "") : "— tab gone, will re-claim"} ${page ? "— " + page.url() : ""}`,
        );
      }
      console.log(`leases on "${PROFILE}":\n` + out.join("\n"));
    });
  },

  async goto() {
    const url = positional()[0];
    if (!url) die("usage: effigy goto <url> [--new] [--wait-for SELECTOR]");
    await withContext(async (context) => {
      // `--new` moves this session's lease to the new tab, so every later
      // command follows it instead of talking to the tab we just left.
      const page = has("new") ? await claimPage(context) : await pickPage(context);
      await page.bringToFront().catch(() => {});
      await page
        .goto(url, { waitUntil: "networkidle", timeout: Number(flag("timeout", 30_000)) })
        .catch(() => page.goto(url, { waitUntil: "load" }));
      const sel = flag("wait-for");
      if (sel) await page.waitForSelector(sel, { timeout: Number(flag("timeout", 30_000)) });
      console.log(`${page.url()}\n${await page.title()}`);
    });
  },

  async shot() {
    const out = positional()[0];
    if (!out) die("usage: effigy shot <out.png> [--full] [--tab N]");
    await withContext(async (context) => {
      const page = await pickPage(context);
      await fsp.mkdir(path.dirname(path.resolve(out)), { recursive: true });
      await page.screenshot({ path: out, fullPage: has("full") });
      console.log(path.resolve(out));
    });
  },

  async text() {
    await withContext(async (context) => {
      const page = await pickPage(context);
      const sel = flag("selector");
      const body = sel ? await page.locator(sel).first().innerText() : await page.locator("body").innerText();
      console.log(body.replace(/\n{3,}/g, "\n\n").trim());
    });
  },

  async click() {
    await withContext(async (context) => {
      const page = await pickPage(context);
      assertNotWalletUI(page);
      const sel = flag("selector");
      const target = sel ? page.locator(sel).first() : page.getByText(positional()[0] ?? "", { exact: false }).first();
      if (!sel && !positional()[0]) die('usage: effigy click "TEXT" | effigy click --selector SEL');
      await target.click({ timeout: Number(flag("timeout", 10_000)) });
      await page.waitForTimeout(400);
      console.log(`clicked: ${sel ?? positional()[0]}\n${page.url()}`);
    });
  },

  async type() {
    const sel = flag("selector");
    const value = positional()[0];
    if (!sel || value === undefined) die('usage: effigy type --selector SEL "text" [--enter]');
    await withContext(async (context) => {
      const page = await pickPage(context);
      assertNotWalletUI(page);
      await page.locator(sel).first().fill(value);
      if (has("enter")) await page.keyboard.press("Enter");
      console.log(`typed into ${sel}`);
    });
  },

  async press() {
    const key = positional()[0];
    if (!key) die("usage: effigy press <Key>");
    await withContext(async (context) => {
      const page = await pickPage(context);
      assertNotWalletUI(page);
      await page.keyboard.press(key);
      console.log(`pressed ${key}`);
    });
  },

  async eval() {
    const js = positional()[0];
    if (!js) die("usage: effigy eval \"document.title\"");
    await withContext(async (context) => {
      const page = await pickPage(context);
      assertNotWalletUI(page);
      const result = await page.evaluate(`(async () => (${js}))()`).catch(() => page.evaluate(js));
      console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
    });
  },

  async wait() {
    const arg = positional()[0];
    if (!arg) die("usage: effigy wait <ms|selector>");
    await withContext(async (context) => {
      const page = await pickPage(context);
      if (/^\d+$/.test(arg)) await page.waitForTimeout(Number(arg));
      else await page.waitForSelector(arg, { timeout: Number(flag("timeout", 30_000)) });
      console.log(`waited: ${arg}`);
    });
  },

  async close() {
    await withContext(async (context) => {
      const page = await pickPage(context);
      await page.close();
      console.log("closed tab");
    });
  },

  console: () => tailLog("console.jsonl"),
  net: () => tailLog("net.jsonl"),

  async run() {
    const file = positional()[0];
    if (!file) die("usage: effigy run <script.mjs>   (default export: async ({context, page}) => {})");
    const mod = await import(path.resolve(file));
    await withContext(async (context) => {
      const page = await pickPage(context);
      const result = await mod.default({ context, page });
      if (result !== undefined) console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
    });
  },

  /**
   * Take a copy of a real Chrome profile's session state, so the effigy window
   * opens already logged into everything you are logged into.
   *
   * Why a copy and not the profile itself: Chrome locks a user-data-dir to one
   * process, so "just point at ~/Library/.../Chrome" would mean quitting his
   * daily browser for the duration. The clone is a snapshot — sessions in it age
   * out as they would anywhere, and `effigy clone --force` re-takes it.
   *
   * The clone MUST be launched with `--channel chrome`: macOS cookie values are
   * encrypted with a key held in the login Keychain under "Chrome Safe Storage",
   * and only the real Chrome binary is on that item's ACL. Playwright's bundled
   * Chromium asks for "Chromium Safe Storage" instead, gets nothing, and every
   * cookie decrypts to an empty string — a silent, total logout. `up` reads the
   * clone marker and picks the right binary on its own.
   */
  async clone() {
    const from = flag("from", "Default");
    const to = flag("to", flag("profile") || (PROFILE === "default" ? "real" : PROFILE));
    // --browser chrome|brave|edge. Default: chrome, unless Chrome has no profile dir and
    // exactly one other supported browser does.
    let browserName = flag("browser");
    if (!browserName) {
      const present = Object.entries(BROWSERS).filter(([, b]) => fs.existsSync(b.root)).map(([k]) => k);
      browserName = present.includes("chrome") || present.length !== 1 ? "chrome" : present[0];
    }
    const browser = BROWSERS[browserName];
    if (!browser) die(`effigy: unknown --browser "${browserName}". Known: ${Object.keys(BROWSERS).join(", ")}`);
    if (browser.exe && !fs.existsSync(browser.exe)) die(`effigy: ${browser.label} binary not found at ${browser.exe}`);
    const SRC_ROOT = browser.root;
    const src = path.join(SRC_ROOT, from);
    const dstRoot = path.join(ROOT, "profiles", to);
    const dst = path.join(dstRoot, "Default");

    if (!fs.existsSync(src)) {
      const avail = fs.existsSync(SRC_ROOT)
        ? fs
            .readdirSync(SRC_ROOT, { withFileTypes: true })
            .filter((e) => e.isDirectory() && fs.existsSync(path.join(SRC_ROOT, e.name, "Preferences")))
            .map((e) => e.name)
        : [];
      die(`effigy: no ${browser.label} profile "${from}". Available: ${avail.join(", ") || "(none)"}`);
    }
    const liveState = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, "state", `${to}.json`), "utf8"));
      } catch {
        return null;
      }
    })();
    if (liveState) die(`effigy: profile "${to}" has a window open. \`effigy down --profile ${to}\` first.`);
    if (fs.existsSync(dst) && !has("force"))
      die(`effigy: "${to}" already exists. Re-take the snapshot with: effigy clone --to ${to} --force`);

    fs.rmSync(dstRoot, { recursive: true, force: true });
    fs.mkdirSync(dst, { recursive: true });

    let files = 0;
    const copyTree = async (relDir) => {
      const absSrc = path.join(src, relDir);
      for (const e of fs.readdirSync(absSrc, { withFileTypes: true })) {
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        if (skipEntry(rel)) continue;
        const s = path.join(src, rel);
        const d = path.join(dst, rel);
        if (e.isDirectory()) {
          fs.mkdirSync(d, { recursive: true });
          await copyTree(rel);
        } else if (e.isFile()) {
          if (SQLITE_FILES.has(rel) && (await copySqlite(s, d))) {
            files++;
            continue;
          }
          try {
            fs.copyFileSync(s, d);
            files++;
          } catch {
            /* files Chrome holds exclusively are not session state */
          }
        }
      }
    };
    await copyTree("");
    // Lives at the user-data-dir root, one level above the profile.
    try {
      fs.copyFileSync(path.join(SRC_ROOT, "Local State"), path.join(dstRoot, "Local State"));
    } catch {
      /* optional */
    }
    fs.writeFileSync(
      path.join(dstRoot, ".effigy-clone.json"),
      JSON.stringify({ from, at: new Date().toISOString(), browser: browserName, sourceRoot: SRC_ROOT }, null, 2),
    );

    console.log(
      [
        `cloned: ${browser.label} "${from}" -> effigy profile "${to}"  (${files} files, ${mb(dirSize(dstRoot))})`,
        `        carried: cookies, localStorage, IndexedDB, service workers, installed extensions`,
        `        left behind: saved passwords, autofill/cards, history, caches`,
        ``,
        `This is a second copy of your logged-in state at rest: ${dstRoot}`,
        `Wipe it any time with: rm -rf ${dstRoot}`,
        ``,
        `next: effigy up --profile ${to}        (uses the real ${browser.label} binary automatically — required to decrypt the cookies)`,
        `      effigy cookies --profile ${to}   (counts only, never values — proves the sessions came across)`,
      ].join("\n"),
    );
  },

  /**
   * Proof that a clone worked, without ever printing a session token: counts by
   * registrable-ish domain, values never touched.
   */
  async cookies() {
    await withContext(async (context) => {
      const all = await context.cookies();
      const host = flag("host");
      const rows = new Map();
      for (const c of all) {
        const d = c.domain.replace(/^\./, "");
        if (host && !d.includes(host)) continue;
        rows.set(d, (rows.get(d) ?? 0) + 1);
      }
      const sorted = [...rows.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(flag("n", 25)));
      console.log(
        `cookies on "${PROFILE}": ${all.length} total across ${rows.size} domains${host ? ` (filtered: ${host})` : ""}\n` +
          sorted.map(([d, n]) => `  ${String(n).padStart(4)}  ${d}`).join("\n"),
      );
    });
  },

  async setup() {
    await up();
    const state = readState();
    await withContext(async (context) => {
      const page = await pickPage(context);
      await page.goto("chrome://extensions/").catch(() => {});
    });
    console.log(
      [
        "",
        "one-time setup, in the window that just opened:",
        "  1. chrome://extensions — confirm Rabby is listed and enabled. Pin it.",
        "     (If it is missing, install Rabby from the Web Store into THIS profile;",
        "      the profile persists, so it only happens once.)",
        "  2. Open Rabby and import a wallet. Use a low-value / testnet wallet:",
        "     this profile is unencrypted on disk and an agent drives pages beside it.",
        "  3. Log into whatever else the flows need (Phala, faucets, dashboards).",
        "     Sessions live in the profile and survive `effigy down`.",
        "",
        `profile dir: ${state?.profileDir}`,
        "leave the window open (or `effigy up` again later — the logins persist).",
      ].join("\n"),
    );
  },

  help: () => console.log(HELP),
};

const tailLog = (name) => {
  const file = logFile(name);
  if (has("clear")) {
    fs.rmSync(file, { force: true });
    return console.log(`cleared ${name}`);
  }
  if (!fs.existsSync(file)) return console.log(`${name}: empty`);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const n = Number(flag("n", 40));
  console.log(
    lines
      .slice(-n)
      .map((l) => {
        try {
          const r = JSON.parse(l);
          return `${r.t.slice(11, 19)} ${r.level ?? r.kind}${r.status ? " " + r.status : ""} ${r.text ?? ""} ${r.url ?? ""}`.trim();
        } catch {
          return l;
        }
      })
      .join("\n") || `${name}: empty`,
  );
};

const HELP = `effigy — headed browser that remembers who you are
           profile: ${PROFILE}   session: ${SESSION}

  up [--port N] [--channel chrome] [--no-rabby] [--window-size W,H] [--ephemeral]
  setup                  one-time wallet/login bootstrap, with checklist
  status | tabs | leases | down [--force]
  claim | release        take / give back this session's tab (lazy — rarely needed)
  goto <url> [--new] [--wait-for SEL]
  shot <out.png> [--full] [--tab N]
  text [--selector SEL] [--tab N]
  click "TEXT" | click --selector SEL
  type --selector SEL "text" [--enter]
  press <Key> | wait <ms|selector> | eval "js" | close
  console [--n 40] [--clear] | net [--n 40] [--clear]
  run <script.mjs>

global: --profile NAME, --as LABEL (override session), --tab N, --timeout MS

Concurrency: every Claude Code session automatically leases its own tab in the
window, so parallel sessions on one profile never steal each other's page.
--ephemeral gives this session a throwaway profile that is deleted on \`down\`.

The agent drives the dapp. Wallet popups are yours — effigy refuses to click them.`;

const fn = commands[command];
if (!fn) {
  console.log(HELP);
  process.exit(command ? 1 : 0);
}
// Playwright throws novel-length errors with call logs; an agent reading stdout
// wants the first line and a hint, not a stack through node internals.
try {
  await fn();
} catch (e) {
  const first = String(e?.message ?? e).split("\n")[0];
  die(`effigy ${command}: ${first}`);
}
