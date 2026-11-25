// End-to-end check of `effigy click --accept-dialogs` through the real CLI and
// daemon, on a throwaway profile (`--ephemeral`) that `down` deletes. It opens a
// headed window for a few seconds and never touches a cloned or signed-in profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const fixture = `<!doctype html><meta charset="utf-8"><title>effigy dialogs fixture</title>
<button id="c" onclick="out.textContent='confirm:'+confirm('Reboot the router?')">Confirm</button>
<button id="p" onclick="out.textContent='prompt:'+prompt('Name?','default-name')">Prompt</button>
<button id="a" onclick="alert('Saved'); out.textContent='alert:returned'">Alert</button>
<button id="d" onclick="setTimeout(()=>{out.textContent='late:'+confirm('Late?')},200)">Late</button>
<pre id="out">idle</pre>`;
// A file, not a local server: execFileSync blocks this process's event loop, so
// an in-process HTTP server could never answer the browser.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'effigy-dialogs-'));
fs.writeFileSync(path.join(dir, 'fixture.html'), fixture);
const url = `file://${path.join(dir, 'fixture.html')}`;

const who = ['--ephemeral', '--as', `dialog-test-${process.pid}`];
const effigy = (...args) => execFileSync(process.execPath, ['effigy.mjs', ...args, ...who], {encoding: 'utf8'}).trim();
const out = () => effigy('text', '--selector', '#out');
const fresh = () => effigy('goto', url);

try {
  effigy('up', '--no-rabby', '--window-size', '800,600');

  fresh(); effigy('click', '--selector', '#c');
  assert.equal(out(), 'confirm:false', 'without the flag Playwright cancels confirm()');

  fresh(); const said = effigy('click', '--selector', '#c', '--accept-dialogs');
  assert.equal(out(), 'confirm:true');
  assert.match(said, /dialog: confirm "Reboot the router\?" -> accepted/);

  // Same document, stand-ins already installed: a new --dialog-text still applies.
  assert.match(effigy('click', '--selector', '#p', '--accept-dialogs', '--dialog-text', 'abc'), /answered "abc"/);
  assert.equal(out(), 'prompt:abc');
  effigy('click', '--selector', '#p', '--accept-dialogs');
  assert.equal(out(), 'prompt:default-name');

  assert.match(effigy('click', '--selector', '#a', '--accept-dialogs'), /dialog: alert "Saved"/);
  assert.equal(out(), 'alert:returned');

  fresh(); effigy('click', '--selector', '#d', '--accept-dialogs');
  assert.equal(out(), 'late:true', 'a confirm() fired after the click is still accepted');

  fresh(); effigy('click', 'Confirm', '--accept-dialogs');
  assert.equal(out(), 'confirm:true', 'click by text works with the flag before or after it');

  console.log('PASS: confirm cancelled without the flag; accepted with it; prompt text per click; alert; delayed confirm; click by text.');
} finally {
  try { effigy('down'); } catch (e) { console.error('down failed:', e.message); }
  fs.rmSync(dir, {recursive: true, force: true});
}
