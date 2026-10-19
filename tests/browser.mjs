import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {pageCommand} from '../extension/page.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'effigy-browser-'));
const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(fs.readFileSync(new URL('./fixture.html',import.meta.url)));}).listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const browser=await chromium.launch({headless:!process.env.HEADED});
try {
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
 const fields=[{selector:'#title',value:'Local φ soundtrack'},{selector:'#style',value:'Sparse piano, 71 bpm'},{selector:'#lyrics',value:'[Humming] mm ...'},{selector:'#exclude',value:'vocals'},{selector:'#slider',value:'63'}];
 // Serialize the same function Chrome scripting.executeScript receives.
 const run=(command,args)=>page.evaluate(`(${pageCommand.toString()})(${JSON.stringify(command)},${JSON.stringify(args)})`);
 assert.equal((await run('fill',{fields})).filled.length,5);
 assert.equal(await page.evaluate(()=>formState.title),'Local φ soundtrack');
 assert.equal(await page.evaluate(()=>formState.lyrics),'[Humming] mm ...');
 assert.equal((await run('fill',{fields:[{selector:'#lyrics',value:''}]})).filled[0].value,'');
 assert.equal((await run('snapshot',{fields})).fields[4].value,'63');
 assert.match((await run('fill',{fields:[{selector:'#secret',value:'x'}]})).__effigyError,/Sensitive/);
 await page.evaluate(()=>document.getElementById('challenge').hidden=false);
 assert.match((await run('click',{selector:'#create'})).__effigyError,/Human verification/);
 assert.equal(await page.evaluate(()=>submissions),0);
 await page.evaluate(()=>document.getElementById('challenge').hidden=true);
 assert.equal((await run('click',{selector:'#create'})).dispatched,true);
 assert.equal((await run('snapshot',{})).songs.length,2);
 await page.screenshot({path:path.resolve('tests/browser-result.png')});
 console.log('PASS: DOM fill/readback, slider, sensitive-field rejection, challenge pause, one submission, two song IDs.');
}finally{await browser.close();server.close();fs.rmSync(dir,{recursive:true,force:true});}
