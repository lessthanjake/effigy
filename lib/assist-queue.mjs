import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {request} from './native-client.mjs';
const hash=job=>createHash('sha256').update(JSON.stringify(job)).digest('hex');
const save=(file,state)=>{fs.writeFileSync(file+'.tmp',JSON.stringify(state,null,2)+'\n',{mode:0o600});fs.renameSync(file+'.tmp',file);};
export async function queueAction(file,action,{allowSubmit=false,send=request}={}) {
 const lock=file+'.lock';
 let fd;
 try{fd=fs.openSync(lock,'wx',0o600);}catch{throw new Error(`Queue is locked: ${lock}. If its process crashed, inspect the saved state before removing this lock.`);}
 try {
  const queue=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!Array.isArray(queue.jobs)||!queue.jobs.length||new Set(queue.jobs.map(j=>j.id)).size!==queue.jobs.length)throw new Error('Queue needs jobs with unique IDs');
  const stateFile=file+'.state.json';
  const state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{jobs:{}};
  if(action==='status')return state;
  const job=queue.jobs.find(j=>!['generated','downloaded'].includes(state.jobs[j.id]?.stage));
  if(!job)return {complete:true,state};
  if(!job.id||!job.title||!job.origin||!Array.isArray(job.fields))throw new Error('Job requires id, title, origin and fields');
  const entry=state.jobs[job.id]??={stage:'new',hash:hash(job)};
  if(entry.hash!==hash(job))throw new Error('Job changed since preparation; use a new job ID');
  const connection=await send('status');
  if(new URL(connection.url).origin!==job.origin)throw new Error('Queue origin does not match selected tab');
  const snapshot=()=>send('snapshot',{fields:job.fields.map(({selector,index})=>({selector,index}))});
  if(action==='prepare') {
   if(['submitting','unknown'].includes(entry.stage))throw new Error('Previous submission outcome unknown; reconcile before proceeding');
   if(entry.stage==='prepared')return {id:job.id,...entry,message:'Already prepared; use reconcile after manual generation or submit explicitly.'};
   const before=await send('snapshot');
   entry.baseline=before.songs.map(s=>s.url);entry.stage='preparing';save(stateFile,state);
   await send('fill',{fields:job.fields});
   const verified=await snapshot();
   if(verified.fields.some((f,i)=>f.value!==job.fields[i].value))throw new Error('Readback mismatch');
   entry.stage='prepared';entry.preparedAt=new Date().toISOString();save(stateFile,state);
   return {id:job.id,stage:entry.stage,submitted:false};
  }
  if(action==='submit') {
   if(!allowSubmit)throw new Error('Submission is manual by default; --allow-submit is required');
   if(entry.stage!=='prepared')throw new Error(`Cannot submit stage ${entry.stage}; reconcile first`);
   const verified=await snapshot();
   if(verified.fields.some((f,i)=>f.value!==job.fields[i].value))throw new Error('Form changed after preparation');
   if(verified.songs.some(s=>!entry.baseline.includes(s.url)&&s.title===job.title))throw new Error('New songs already visible; reconcile instead of submitting again');
   if(!job.submit?.selector)throw new Error('No submit button configured');
   entry.stage='submitting';entry.submittedAt=new Date().toISOString();save(stateFile,state);
   try{await send('click',job.submit);}catch(error){entry.stage='unknown';entry.error=error.message;save(stateFile,state);throw error;}
   // A click acknowledgement is not generation success. No automatic retry.
   entry.stage='unknown';save(stateFile,state);
   return {id:job.id,stage:'unknown',message:'Submission dispatched; reconcile to find resulting song IDs.'};
  }
  if(action==='reconcile') {
   if(!entry.baseline)throw new Error('Prepare the job before reconciling');
   const current=await send('snapshot');
   const songs=current.songs.filter(s=>!entry.baseline.includes(s.url)&&s.title===job.title);
   if(songs.length>=(job.expectedSongs||2)){
    entry.stage='generated';entry.songs=songs;entry.observedAt=new Date().toISOString();delete entry.error;
   }
   save(stateFile,state);return {id:job.id,...entry,message:songs.length?'Song IDs observed; audio completion/download still need checking.':'No new matching songs visible; no retry performed.'};
  }
  throw new Error('Queue action must be status, prepare, submit or reconcile');
 } finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
