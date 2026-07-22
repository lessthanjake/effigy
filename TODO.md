# Open threads

Written down because the session that produced them may never resume. If you are
back here troubleshooting, start with this file.

## Deferred: the Playwright MCP `--extension` bridge is still installed

Not removed, on purpose — it may still be wanted, and it is the only stack that drives
your *actual* daily Chrome profile rather than a clone of it. effigy replaces it for
everything else.

It is registered in `~/.claude.json` as `npx @playwright/mcp@latest --extension`.

**If it is misbehaving, this is almost certainly why:** the extension can attach to
exactly ONE relay at a time, but every agent session spawns its own MCP server on its
own relay port. Five were found running at once, one per session ever opened. So the
bridge doesn't fail randomly — it works only for whichever session last clicked
Connect, and "reconnecting" steals it from the session that had it. The recurring
`connect.html?mcpRelayUrl=ws://[::1]:<port>` tab is the bridge idling with no page
bound, not stale garbage.

Symptom to recognize: `Target page, context or browser has been closed`, repeatedly,
right after it worked once.

Options, whenever it's worth deciding:

- **Remove it** from `~/.claude.json` — effigy covers every use except driving the
  real daily profile live.
- **Keep but pin the version** — `@latest` re-resolves on every start, so the relay
  protocol can change under you between sessions.
- **Housekeeping either way** — `pkill -f playwright-mcp` when servers pile up.

## Decided: clones deliberately carry the real wallet

`effigy clone` copies the source profile's extensions *including* the wallet and its
encrypted vault, so testing signing flows needs no separate wallet setup. Verified: a
cloned profile's Rabby shows the unlock screen (a vault is present) rather than
onboarding (empty).

**Do not "fix" this by adding the wallet to `CLONE_SKIP`.** It is the intended
behavior. The tradeoff was weighed: the vault stays encrypted with its own password
exactly as the original is, and no agent can act on it — effigy refuses to click or
type in `chrome-extension://` pages. If you ever want the smaller blast radius
instead, skip `Extensions/<wallet-id>` and `Local Extension Settings/<wallet-id>`,
and keep a separate low-value wallet profile for signing.
