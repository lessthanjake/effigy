# effigy

A headed browser that remembers who you are.

`effigy` is the **headed** browser stack: a Chromium that Playwright launches itself,
against a dedicated persistent profile, exposed on a fixed CDP port. Log it into a
site once — Phala, GitHub, a staging dashboard, a faucet, Rabby — and every later run
inherits that session. The daemon holds the body; each command is a short-lived client
that steps in, acts, and steps out.

**Wallets are one use, not the use.** The thing effigy actually provides is *continuity*:
a browser that is still someone tomorrow. Most profiles will never load a wallet
(`effigy up --no-rabby`). Reach for a plain headless Playwright script when you want the
opposite — a clean, anonymous, deterministic first-time visitor with no window.

```
effigy clone                                 # once: take a snapshot of your real Chrome sessions
effigy up --profile real                     # boot the window
effigy goto https://cloud.phala.network/dashboard   # already logged in
effigy shot /tmp/dash.png --full
effigy text | head -40
effigy console --n 20
```

## Two things it gets right that are easy to get wrong

**Your existing logins, without logging in again.** `effigy clone` snapshots a real
Chrome profile — cookies, localStorage, IndexedDB, service workers, installed
extensions — into an effigy profile. Verified: 3642 cookies across 741 domains,
`github.com` reporting the signed-in account, a Phala dashboard rendering a
logged-in workspace. Your daily Chrome is never driven and never locked.

**Many sessions at once.** You may have several agent sessions open and any of them may
want a browser. Each session automatically leases its own tab (keyed on
`CLAUDE_CODE_SESSION_ID`), so parallel agents share one logged-in window without
stealing each other's page. This is the failure the MCP extension bridge could not
survive: one extension, N relay ports, last-connect-wins.

## Install

Requires **macOS** (Chrome's profile layout and the Keychain-backed cookie
encryption are macOS-specific) and **Node ≥ 20.11** (`import.meta.filename`).

```
git clone git@github.com:<you>/effigy.git ~/.claude/tools/effigy
cd ~/.claude/tools/effigy
npm install                                   # one dep: playwright (~150MB Chromium)
ln -sf "$PWD/effigy.mjs" ~/.local/bin/effigy  # or anywhere on PATH
effigy help
```

Also expected:

- **Google Chrome**, at `/Applications/Google Chrome.app` — required for cloned
  profiles, which will not decrypt their cookies under any other binary. Uncloned
  profiles use Playwright's bundled Chromium and don't need it.
- **`/usr/bin/sqlite3`** — ships with macOS. Used to snapshot the cookie DB
  consistently while Chrome is running; without it the clone falls back to a plain
  file copy, which can catch a half-written page.
- **Rabby**, only if you want a wallet in an uncloned profile. Cloned profiles bring
  whatever extensions the source profile had.

Nothing is written outside `~/.effigy/` (profiles, logs, lease state) and the symlink.
No config file, no daemon at login, no MCP registration.

## Why it exists

The Playwright MCP `--extension` bridge drives the real Chrome through a websocket
relay whose port is reassigned every time the MCP server restarts. The extension keeps
pointing at the dead port, so mid-flow every call dies with *"Target page, context or
browser has been closed"*, and only a manual Chrome-side re-handshake (extension icon →
Connect) revives it. Fine for one action; unusable across a multi-step flow.

effigy deletes the relay from the picture. Nothing to re-handshake, no port to go stale,
no fight with the daily-driver Chrome profile (which is locked by the running Chrome and
must never be used here — hence a separate `userDataDir`).

|                       | headless script | **effigy** | Playwright MCP `--extension` |
|-----------------------|-----------------|------------|------------------------------|
| headed                 | no             | **yes**    | yes                          |
| carries your sessions  | no             | **yes**    | yes (your real Chrome)       |
| wallet available       | no             | **yes**    | yes                          |
| survives restarts      | n/a            | **yes**    | no — the failure mode        |
| parallel agent sessions| n/a            | **yes** — one tab each | no — one extension, N relays |

## The one thing it will not do

effigy **refuses to click or type into any `chrome-extension://` page.** The agent drives
the dapp and may initiate a transaction; the Rabby popup is yours to sign or reject.
That rule is enforced in `assertNotWalletUI()`, not just written down. Read-only
inspection of wallet UI (`shot --tab N`, `text --tab N`) is allowed, so an agent can
report *what* is being asked for without touching it.

## Cloning a real Chrome profile

```
effigy clone [--from Default] [--to real] [--force]
effigy up --profile real
effigy cookies --profile real          # counts by domain, never values
```

Carried: cookies, Local/Session Storage, IndexedDB, service worker databases,
installed extensions (Rabby included, with its vault).
**Deliberately left behind:** saved passwords (`Login Data`), autofill and card
numbers (`Web Data`), history, and every cache. A logged-in browser needs none of
them — the cookies already carry the sessions — so the clone does not put your
password store in a second place on disk.

It is a **snapshot**, ~2GB, at `~/.effigy/profiles/real`. Sessions in it age out
like any others; `effigy clone --force` re-takes it, and `effigy status` tells you
how old it is. Delete it any time: `rm -rf ~/.effigy/profiles/real`.

### Two flags that silently destroy a clone

Playwright's defaults are tuned for throwaway browsers, and two of them are quietly
fatal here. Both are stripped via `ignoreDefaultArgs`; if you fork this launch code,
keep them stripped.

- **`--use-mock-keychain`** — macOS cookie values are encrypted with a key in the login
  Keychain. The mock keychain hands Chrome the wrong key, and Chrome's response to
  cookies it cannot decrypt is to **delete them**. The window comes up looking perfect
  and every session is gone. This is how it was found: 3701 cookies in, 8 left.
- **`--disable-extensions`** — beats `--load-extension`, so the wallet simply isn't there
  and `chrome-extension://` URLs return `ERR_BLOCKED_BY_CLIENT`.

A cloned profile also **must** run the real Chrome binary (`channel: "chrome"`) — only
it is on the Keychain item's ACL. `up` detects the clone marker and does this for you.

## One-time setup (uncloned profiles only)

```
effigy setup --profile work
```

Boots the window and prints a checklist:

1. **chrome://extensions** — confirm Rabby is listed and enabled, then pin it.
   effigy copies the newest Rabby it finds in your real Chrome profiles into
   `~/.effigy/extensions/` and loads it unpacked. The copy carries *code only* —
   a freshly loaded Rabby is an empty wallet. If it is missing, install Rabby from
   the Web Store into this profile; the profile persists, so it happens once.
2. **Import a wallet into that Rabby.** Use a low-value or testnet wallet. This
   profile is unencrypted on disk and an agent drives pages next to it.
3. **Log into whatever else the flows need.** Sessions live in the profile and
   survive `effigy down`.

Profiles are independent: `--profile work`, `--profile personal`, each with its
own logins, wallet, and port. `EFFIGY_PROFILE=work` sets it for a shell.
(zsh does not word-split unquoted vars — `P="--profile x"; effigy status $P` passes one
mangled argument. Use the env var or spell the flag out.)

## Commands

| | |
|---|---|
| `clone [--from Default] [--to real] [--force]` | snapshot a real Chrome profile's sessions |
| `cookies [--host X] [--n 25]` | cookie counts by domain — never values |
| `leases` / `claim` / `release` | who owns which tab; take one; give it back |
| `up [--port N] [--channel chrome] [--no-rabby] [--window-size W,H] [--ephemeral]` | boot the daemon |
| `setup` | `up` + the one-time checklist |
| `status` / `tabs` / `down` | inspect / list tabs / stop |
| `goto <url> [--new] [--wait-for SEL]` | navigate (current tab, or a new one) |
| `shot <out.png> [--full]` | screenshot |
| `text [--selector SEL]` | visible text — cheaper than a screenshot for assertions |
| `click "TEXT"` / `click --selector SEL` | click |
| `type --selector SEL "text" [--enter]` | fill a field |
| `press <Key>` / `wait <ms\|selector>` / `close` | keyboard, waiting, close tab |
| `eval "js"` | evaluate in the page (expression or async IIFE body) |
| `console [--n 40] [--clear]` | errors/warnings the pages logged while nobody was watching |
| `net [--n 40] [--clear]` | failed requests and ≥400 responses |
| `run <script.mjs>` | escape hatch: `export default async ({context, page}) => {}` |

Global flags: `--profile NAME`, `--as LABEL` (override the auto session key),
`--tab N` (indexes the `tabs` listing), `--timeout MS`.

### Concurrency

Every command resolves to *this session's* tab, claimed on first use and re-claimed if
it was closed — leases key on the CDP targetId, so they survive navigation and tab
reordering. `effigy tabs` marks each tab with its owner; `effigy down` refuses when
another session still holds a tab (`--force` overrides). Ports are allocated, not
assigned, so N profiles across N sessions never coordinate on a number, and two
sessions racing `up` on the same profile end up sharing one window rather than one
crashing on Chrome's profile lock.

`--ephemeral` gives a session a throwaway profile (`eph-<session>`), deleted on `down`
— for anonymous work that should not touch a real identity. Say it once; later
commands in that session find it.

`console` and `net` matter more than they look: the daemon attaches listeners to every
page as it opens, so the log covers the whole session — including whatever happened
while you were clicking through a wallet popup with no client connected.

## Where things live

```
~/.effigy/profiles/<name>     the user-data-dir — logins, wallet, extensions.  Never commit.
~/.effigy/state/<name>.json   pid, port, profile dir (deleted when the window closes)
~/.effigy/logs/<name>/        daemon.log, console.jsonl, net.jsonl
~/.effigy/extensions/         Rabby, copied out of the real Chrome profile
```

## Troubleshooting

**"no daemon for profile X"** — `effigy up`. If you closed the window, the daemon exits
and clears its own state; that message is the expected next step, not an error.

**"daemon exited immediately"** — the last lines of `daemon.log` are printed with it. The
usual cause is a profile already in use by another Chromium.

**"port N is already serving CDP for something else"** — `--port` it, or find the squatter.
Default port is 9333, chosen to stay clear of the 9222 that everything else grabs.

**Rabby is missing after `up`** — Playwright passes `--disable-extensions` by default, which
silently beats `--load-extension`. effigy strips it (and
`--disable-component-extensions-with-background-pages`) via `ignoreDefaultArgs`; if you fork
this launch code, keep that. Verify with
`curl -s localhost:9333/json/list | grep acmacodkjbdgmoleebolmdjonilkdbch` — a
`service_worker` target means it loaded. Chrome stable ≥137 dropped `--load-extension`
entirely, which is why effigy runs Playwright's bundled Chromium and not `--channel chrome`.

**Collision with gstack `/browse`** — that daemon lingers and fights over CDP. `up` warns
when it sees one; kill it with `pkill -f 'gstack/browse/src/server.ts'`. One headed stack
at a time.

## Related

- A plain `chromium.launch()` screenshot script — still the right default when no
  session, wallet, or window is needed.
- Your project's own Playwright test suite — the assertion layer. effigy is for
  looking; tests are for proving.
