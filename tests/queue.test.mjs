import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {queueAction} from '../lib/assist-queue.mjs';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'effigy-queue-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'queue.json');
 fs.writeFileSync(file,JSON.stringify({jobs:[{id:'a',title:'Track A',origin:'http://localhost:1234',fields:[{selector:'#title',value:'Track A'}],submit:{selector:'#create'}}]}));
 let songs=[],clicks=0;const calls=[];
 const send=async(command,args)=>{calls.push(command);if(command==='status')return {url:'http://localhost:1234/create'};if(command==='snapshot')return {fields:[{value:'Track A'}],songs};if(command==='click'){clicks++;throw new Error('Disconnected after click');}return {};};
 return {file,send,calls,setSongs:value=>{songs=value;},clicks:()=>clicks};
}
test('manual preparation never clicks and can reconcile after process restart',async t=>{
 const f=fixture(t);await queueAction(f.file,'prepare',{send:f.send});assert.equal(f.clicks(),0);
 await assert.rejects(queueAction(f.file,'submit',{send:f.send}),/manual by default/);
 f.setSongs([{title:'Track A',url:'http://localhost:1234/song/1'},{title:'Track A',url:'http://localhost:1234/song/2'}]);
 const r=await queueAction(f.file,'reconcile',{send:f.send});assert.equal(r.stage,'generated');assert.equal(r.songs.length,2);
 assert.equal((await queueAction(f.file,'prepare',{send:f.send})).complete,true);
});
test('uncertain submission is persisted and cannot be replayed',async t=>{
 const f=fixture(t);await queueAction(f.file,'prepare',{send:f.send});
 await assert.rejects(queueAction(f.file,'submit',{allowSubmit:true,send:f.send}),/Disconnected/);
 assert.equal(JSON.parse(fs.readFileSync(f.file+'.state.json')).jobs.a.stage,'unknown');
 await assert.rejects(queueAction(f.file,'submit',{allowSubmit:true,send:f.send}),/Cannot submit/);
 await assert.rejects(queueAction(f.file,'prepare',{send:f.send}),/outcome unknown/);assert.equal(f.clicks(),1);
});
test('manual generation prevents a duplicate automatic submit',async t=>{
 const f=fixture(t);await queueAction(f.file,'prepare',{send:f.send});
 f.setSongs([{title:'Track A',url:'http://localhost:1234/song/1'}]);
 await assert.rejects(queueAction(f.file,'submit',{allowSubmit:true,send:f.send}),/already visible/);assert.equal(f.clicks(),0);
});
test('origin mismatch cannot fill a different site',async t=>{
 const f=fixture(t);const send=async c=>c==='status'?{url:'https://example.com'}:f.send(c);
 await assert.rejects(queueAction(f.file,'prepare',{send}),/origin/);assert.equal(f.calls.length,0);
});
