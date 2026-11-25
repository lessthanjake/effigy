# Effigy Assist — native browser prototype

This branch adds `effigy assist ...` alongside the existing Playwright commands. It controls a user-selected tab through a Manifest V3 extension and Native Messaging. It does not launch Chrome, clone profiles, attach a debugger, change fingerprints, or interact with Cloudflare frames. Existing Effigy daemon commands are unchanged.

## Current scope

- `status`, `snapshot`, verified `fill`, visible text-button clicks, and `pause` through a private local Unix socket.
- Persisted generation queue: prepare, optional explicit submit, reconcile observed song IDs.
- Human generation is the default. `submit` requires `--allow-submit` on every invocation.
- Visible challenges stop commands. Detection is conservative and cannot identify every site-level failure. The assistant does not solve challenges or repeatedly resubmit.
- Supported origins: `https://suno.com`, `http://127.0.0.1`, `http://localhost`. Clicking the extension grants temporary activeTab access to that origin; no extra permissions prompt is needed. Wallet/extension pages are excluded.
- One selected tab and one command at a time. Pause prevents new commands; it cannot roll back an action already dispatched.
- Downloads, playlist picking, automatic batch advancement, and audio completion detection are **not implemented in this first prototype**. Song IDs observed does not mean audio is finished.
- Sliders and rich-text fields depend on the site's handlers accepting browser events. Readback is checked, but server acceptance and editor framework state must still be tested on Suno.

## Install once in normal Chrome (macOS)

From this checkout:

```sh
node native/install.mjs
```

This writes `~/.effigy/assist/native-host.sh` and the user-level Chrome native host manifest. Keep this checkout in a stable location; the launcher points to it. Re-run the installer if moving it or upgrading Node. No saved cookies or credentials are copied.

In your normally launched Google Chrome:

1. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this checkout's `extension` folder.
2. Open the Suno tab. Click **Effigy Assist (Local)** in Chrome's Extensions menu. Pinning the extension is optional.

The icon says ON after selection. Click again to pause. NO means the active page is unsupported. ERR includes the exact activation failure in the icon tooltip and saves it as `lastError` in extension-local storage. A native-host connection error changes it to OFF; the tooltip explains the error. WAIT indicates a refused or failed command. Initial setup needs several clicks; normal sessions need one tab-selection action. An optional shortcut can be assigned at `chrome://extensions/shortcuts`.

The extension ID is fixed by its manifest key: `nohbkchohilccjlcklaoceogolbfhnho`. Native Messaging accepts this extension only. Native traffic uses length-prefixed JSON, never stdout logging. The local socket is 0600 inside a 0700 directory. Same-user local processes can issue commands, so this is not a sandbox against other software running as your user.

## Trial

```sh
node effigy.mjs assist status
node effigy.mjs assist snapshot
node effigy.mjs assist queue prepare examples/suno-archive.json
# User clicks Generate. Assistant checks the result:
node effigy.mjs assist queue reconcile examples/suno-archive.json
node effigy.mjs assist queue status examples/suno-archive.json
```

Before using the Suno example, the form must be in Advanced mode with More Options expanded, custom duration enabled and TOP inspiration selected. Those prerequisites are not automated yet. The assistant can drive ordinary buttons with the native bridge once selectors are inspected, but should not guess or require the user to type prompts. The first live trial is preparation only; stop if controls do not read back correctly.

To explicitly enable a single submission after agreeing to automatic generation:

```sh
node effigy.mjs assist queue submit examples/suno-archive.json --allow-submit
```

Submitting persists an uncertain state **before** clicking. Neither a click acknowledgement nor a timeout is treated as success. Reconcile compares new song URLs and titles against the pre-fill baseline. A saved uncertain job cannot be automatically resubmitted. If a job genuinely failed, inspect it before creating a new job ID. Do not delete its state merely to retry. If the script crashes with a queue lock, inspect the saved state and confirm no process is running before removing that specific `.lock` file.

The current example is one pair, not the entire soundtrack. Queue state is written beside the JSON and excluded from Git. Per-job origin checking and extension origin checking protect against accidental navigation. No general page-eval command exists in this transport.

## Tests

```sh
npm test
npm run test:browser
npm run test:native
```

Browser tests need Playwright's installed Chromium / Chrome for Testing and permission to listen on localhost. `test:native` launches an isolated test profile, installs a native host **inside that temporary profile**, and exercises the actual extension → Native Messaging → Unix socket → CLI route. Only the temporary extension copy pregrants localhost permission and exposes a startup hook. Production activation still requires the user clicking the extension. It does not connect to Suno or spend credits. Screenshots go to `tests/*-result.png` (ignored).

A passing local test does not establish Cloudflare compatibility. The real Chrome trial must still prove connection, form correctness, and generation after legitimate verification. Persistent verification failures should be handled with Suno support, not challenge evasion.

## Rollback

Pause the extension, remove it from `chrome://extensions`, and remove only `com.effigy.assist.json` from Chrome's NativeMessagingHosts folder and the `~/.effigy/assist` installation files. The old Effigy CLI/profile remains separate and unchanged.

## Design references

- https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/
