# effigy — notes for the agent driving it

`effigy` is a headed browser daemon with a persistent, usually *logged-in* profile.
You drive it from the shell; it is not an MCP server and has no tool schema.

## Driving it

```
effigy status                 # is a window up, whose tabs, how old the clone is
effigy up --profile real      # boot (idempotent — safe if another session did it)
effigy goto <url> [--wait-for SEL]
effigy text | head -40        # cheaper than a screenshot for assertions
effigy shot /tmp/x.png --full # then Read the png — verify mechanics yourself
effigy console --n 20         # errors the pages logged while nobody was connected
```

`--profile real` is the cloned, signed-in identity: use it for anything behind a
login. Uncloned profiles are strangers and will show you sign-in pages.

## Rules

1. **Never `effigy down --force` on a shared profile.** Other agent sessions have tabs
   in that window; `--force` closes it on all of them. `effigy release` gives back
   only your tab. Plain `down` already refuses when others hold leases — do not
   route around it.
2. **Never interact with `chrome-extension://` pages.** The tool refuses clicks and
   typing there; do not look for a way around it. The human signs wallet popups.
   Reading them (`shot --tab N`, `text --tab N`) is fine and often the useful move:
   report *what* is being asked for.
3. **Do not print cookie values, tokens, or page content from an authenticated
   session** beyond what the task needs. `effigy cookies` reports counts by domain
   for exactly this reason.
4. **Screenshot and Read before handing anything to the human.** Confirm it loaded,
   the console is clean, the thing you claim is there is there.
5. If a page shows logged-out, check `effigy status` for the clone's age before
   assuming a bug — a stale snapshot looks exactly like a broken tool.

## Working on effigy itself

The daemon re-execs this file as `__daemon`; clients are short-lived CDP connections
(`connectOverCDP`, then `browser.close()` detaches without killing the window).

Three landmines, all found the hard way — keep the `ignoreDefaultArgs` list intact:

- `--use-mock-keychain` (Playwright default) makes Chrome fail to decrypt macOS
  cookies, and its response is to **delete them**. A cloned profile launched with it
  loses every session on first run, silently. Stripped for clones only.
- `--disable-extensions` (Playwright default) silently beats `--load-extension`;
  the wallet is simply absent and `chrome-extension://` returns `ERR_BLOCKED_BY_CLIENT`.
- Cloned profiles must run `channel: "chrome"` — only the real Chrome binary is on
  the Keychain item's ACL. Chrome ≥137 also dropped `--load-extension`, which is why
  uncloned profiles use Playwright's bundled Chromium instead.

Tab leases key on the CDP `targetId` (via `newCDPSession` → `Target.getTargetInfo`),
not on an index into `context.pages()` — indices reorder as other sessions open tabs.
Lease files are one-per-session so concurrent writers never touch the same file.

Verify changes against a live window, not by reading: boot, run a command of each
kind, check `effigy cookies` still returns thousands (8 means the keychain flag
regressed), and take the daemon down.
