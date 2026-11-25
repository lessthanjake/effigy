import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {request} from '../lib/native-client.mjs';
import {queueAction} from '../lib/assist-queue.mjs';
const root='/private/tmp/effigy-assist-native-test';
process.env.EFFIGY_ASSIST_DIR=root;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'effigy-native-e2e-'));
const ext=path.join(dir,'extension');fs.cpSync('extension',ext,{recursive:true});
// Only the test copy has pregranted localhost access. Production requires an explicit user gesture.
fs.appendFileSync(path.join(ext,'background.js'),'\nglobalThis.testConnect = connect;\n');
const manifest=JSON.parse(fs.readFileSync(path.join(ext,'manifest.json')));manifest.host_permissions=['http://127.0.0.1/*'];
fs.writeFileSync(path.join(ext,'manifest.json'),JSON.stringify(manifest));
const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(fs.readFileSync(new URL('./fixture.html',import.meta.url)));}).listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const origin=`http://127.0.0.1:${server.address().port}`;
execFileSync(process.execPath,['native/install.mjs','--root',root,'--manifest-dir',path.join(dir,'profile','NativeMessagingHosts')]);
const context=await chromium.launchPersistentContext(path.join(dir,'profile'),{channel:'chromium',headless:false,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});
try{
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 worker.on('console',msg=>console.log('extension:',msg.text()));
 const page=await context.newPage();await page.goto(origin);
 // Simulate user tab selection in test; do not control an extension UI or production tab.
 await worker.evaluate(async origin=>{
  const tabs=await chrome.tabs.query({});const tab=tabs.find(t=>t.url?.startsWith(origin));
  await chrome.storage.local.set({selection:{tabId:tab.id,origin}});
  globalThis.testConnect();
 },origin);
 let connected=false;
 for(let i=0;i<30;i++){try{await request('status');connected=true;break;}catch{await new Promise(r=>setTimeout(r,200));}}
 if(!connected)console.log('Native host diagnostic:',await worker.evaluate(async()=>({title:await chrome.action.getTitle({}),id:chrome.runtime.id})));
 assert.equal(connected,true,'native connection should be available');
 const file=path.join(dir,'queue.json');
 fs.writeFileSync(file,JSON.stringify({jobs:[{id:'native-pair',origin,title:'Native bridge soundtrack',expectedSongs:2,fields:[{selector:'#title',value:'Native bridge soundtrack'},{selector:'#style',value:'F minor, 71 bpm'},{selector:'#lyrics',value:''},{selector:'#exclude',value:'vocals'},{selector:'#slider',value:'63'}],submit:{selector:'#create'}}]}));
 await queueAction(file,'prepare');assert.equal(await page.evaluate(()=>submissions),0);
 await queueAction(file,'submit',{allowSubmit:true});
 const reconciled=await queueAction(file,'reconcile');assert.equal(reconciled.stage,'generated');assert.equal(reconciled.songs.length,2);
 assert.equal(await page.evaluate(()=>submissions),1);
 // Disconnect/reconnect CLI clients above, persist queue, and re-run: never duplicate.
 assert.equal((await queueAction(file,'prepare')).complete,true);
 await page.evaluate(()=>document.getElementById('challenge').hidden=false);
 await assert.rejects(request('click',{selector:'#create'}),/Human verification/);
 assert.equal(await page.evaluate(()=>submissions),1);
 await page.evaluate(()=>document.getElementById('challenge').hidden=true);
 await page.screenshot({path:path.resolve('tests/native-browser-result.png')});
 await page.goto('about:blank');await assert.rejects(request('snapshot'),/changed origin/);
 await request('pause');await assert.rejects(request('snapshot'),/No selected tab/);
 console.log('PASS: real extension → Native Messaging host → Unix socket → CLI; fill, submit, reconcile, no duplicate, challenge pause, origin protection and deselection.');
}finally{await context.close();server.close();fs.rmSync(dir,{recursive:true,force:true});}
