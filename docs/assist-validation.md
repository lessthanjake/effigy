# Prototype validation — 2026-10-19

Recorded on the `feature/native-browser-assist` branch before it merged into main.

Passed:
- Six Node tests: native framing including split/UTF-8 messages and size rejection; manual queue preparation/reconciliation; uncertain-submit persistence and no replay; duplicate-submit prevention; wrong-origin refusal.
- Browser fixture: native input events update form state, rich-text insertion/deletion, slider readback, password field rejection, visible challenge pause, one test submission and two observed song IDs.
- End-to-end browser fixture: real MV3 extension, Chrome Native Messaging host and local Unix socket, CLI commands, queue resume, origin-change refusal, deselection.
- Inspected the resulting browser screenshot and checked Git whitespace errors.

The native test uses an isolated Chrome for Testing profile and a temporary extension copy with localhost pregranted. Selection is seeded by the test harness, so normal Chrome's user-driven install/permission flow remains to be tested. No Suno generation was attempted by these tests.

Installed the production host registration at the user-level Google Chrome NativeMessagingHosts directory. The extension itself still needs to be loaded in ordinary Chrome. No existing Effigy launcher, profile, cookie store, or ~/.local/bin/effigy symlink was changed. The executable is `node effigy.mjs assist ...` from the checkout the host was installed from.

Not yet verified: ordinary-Chrome activation, Suno's actual React/editor state, TOP picker and custom-duration setup, Suno submission acceptance, Cloudflare behavior. Download automation is a later stage. The prototype deliberately fails instead of claiming success on a field mismatch or uncertain submission.
