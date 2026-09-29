---
name: effigy
description: Drive a headed, logged-in browser from the shell with the effigy CLI (Playwright daemon, persistent profiles cloned from Chrome/Brave/Edge). Use when a task needs a real signed-in web session — ClickUp, Google, Slack, Gmail, admin consoles, dashboards — for reading pages, clicking, filling forms, or screenshots, and when an API or MCP connector does not expose the setting you need. Also use when the user says "use effigy", "open it in the browser", or "log in as me".
---

# effigy — headed browser that remembers who you are

effigy is a Node CLI, not an MCP server. You call it with Bash. A daemon holds one
Chromium window per profile; every command is a short client that steps in and out.
Each Claude Code session automatically leases its own tab, so parallel sessions share
one window without stealing pages.

Repo: https://github.com/lessthanjake/effigy — canonical copy of this file lives at
`skill/SKILL.md` there. `~/.claude/skills/effigy` is a symlink to that folder.

## If effigy is not installed

Check: `test -x ~/.claude/tools/effigy/effigy.mjs && echo ok`. If missing, tell the user
and offer these steps (macOS only, Node ≥ 20.11):

```
git clone https://github.com/lessthanjake/effigy.git ~/.claude/tools/effigy
cd ~/.claude/tools/effigy && npm install            # one dep: playwright (~150 MB Chromium)
ln -sfn ~/.claude/tools/effigy/skill ~/.claude/skills/effigy   # this skill, every session
ln -sf ~/.claude/tools/effigy/effigy.mjs ~/.local/bin/effigy    # optional, puts it on PATH
```

Then the one-time identity clone, which snapshots the user's real browser sessions
(cookies, storage, extensions; never passwords or history) into a profile named `real`:

```
effigy clone --browser brave        # or chrome | edge — whichever they actually use
effigy status                       # shows the clone's age
```

The clone must be launched with the same browser binary it came from (cookies are
Keychain-encrypted per browser); `up` reads the clone marker and does that itself.

## Invocation

Without the PATH symlink, every call is `node ~/.claude/tools/effigy/effigy.mjs <cmd>`.
Flags go **after** the subcommand: `effigy goto --profile real <url>`, not
`effigy --profile real goto <url>` (the latter prints help).

**Always use `--profile real`** for anything behind a login. The bare `default` profile
is an uncloned stranger and lands on sign-in pages. If a page shows logged-out under
`real`, run `effigy status` and check the clone's age before assuming a bug; a stale
snapshot looks exactly like a broken tool (`effigy clone --force` refreshes it).

```
effigy up --profile real                          # idempotent; safe if another session did it
effigy goto --profile real <url> [--wait-for SEL]
effigy text --profile real | head -60             # cheaper than a screenshot for assertions
effigy shot --profile real /path/out.png [--full] # then Read the png
effigy click --profile real "Exact button text"   # or --selector CSS
effigy type --profile real --selector 'input[placeholder="Search"]' "query" [--enter]
effigy eval --profile real "(()=>{ ... return x })()"
effigy press --profile real Escape | wait 1500 | console --n 20 | net --n 20
effigy release --profile real                     # give back only your tab when done
```

## Working method

1. `up`, `goto`, `wait` 3–8 s for SPAs, `shot`, **Read the screenshot**. Never claim a
   page state you have not looked at.
2. Prefer stable hooks: `data-test`, `aria-label`, placeholder text. Find them with
   `eval` (`document.querySelector(...)?.outerHTML.slice(0,200)`) before clicking.
3. `click "TEXT"` times out when the text matches more than one element or a
   non-clickable span. Fall back to `eval` with a full mouse-event sequence on the
   element at a point:
   `const el=document.elementFromPoint(x,y); for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0}))`
4. Coordinates from a Read screenshot are in image pixels. Retina windows render at
   DPR 2, so **CSS px = image px / 2** (or × 0.72 when the Read tool downscaled a
   2880-wide shot to 2000). Verify with `eval "devicePixelRatio"` once per session.
5. `Escape` closes the whole modal stack in many apps, not just the top menu. After it,
   re-screenshot before clicking; a click meant for a menu can land on the page behind.
6. Framework apps re-render on hover; if a hover-revealed control does not appear,
   look for the same action in a settings gear or a manager dialog instead.
7. Toasts ("View saved", "Added field") are the confirmation. Screenshot within ~2 s.
8. When a change can be verified through an API or MCP tool afterwards, do that and
   report it as verified; report UI-only outcomes as "confirmed on screen".

## Rules (enforced or expected)

- **Never `effigy down --force` on a shared profile.** Other sessions hold tabs there.
  `release` gives back only yours; plain `down` refuses while others hold leases.
- **Never click or type into `chrome-extension://` pages.** The tool refuses; wallet
  popups are the human's. Reading them (`shot --tab N`, `text --tab N`) is fine.
- **Do not print cookie values, tokens, passwords, or authenticated page content**
  beyond what the task needs. `effigy cookies` reports counts by domain for this reason.
  If a page you scraped contains credentials, do not echo them into chat or files.
- Configuration changes in third-party apps (workspace settings, permissions, billing,
  public posts) need the user's explicit ask in chat before you click Save.
- effigy shares the machine: one headed stack at a time. If `up` warns about a
  `gstack /browse` daemon, kill that first.

## Where things live

```
~/.claude/tools/effigy/        the repo: effigy.mjs, README.md, CLAUDE.md, skill/SKILL.md
~/.effigy/profiles/<name>      user-data-dir (logins, extensions). Never commit, never share.
~/.effigy/state/<name>.json    pid, port, profile dir
~/.effigy/logs/<name>/         daemon.log, console.jsonl, net.jsonl
```

Full command table and the launch-flag landmines (`--use-mock-keychain`,
`--disable-extensions`) are in the repo README and CLAUDE.md.
