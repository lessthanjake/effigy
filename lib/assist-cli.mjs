import fs from 'node:fs';
import {request} from './native-client.mjs';
import {queueAction} from './assist-queue.mjs';
export async function main(args) {
 const [command,...rest]=args;
 if(command==='status'||command==='pause')return console.log(JSON.stringify(await request(command),null,2));
 if(command==='snapshot')return console.log(JSON.stringify(await request('snapshot'),null,2));
 if(command==='inspect')return console.log(JSON.stringify(await request('inspect'),null,2));
 if(command==='click-text')return console.log(JSON.stringify(await request('click',{text:rest.join(' ')}),null,2));
 if(command==='fill'){
  const job=JSON.parse(fs.readFileSync(rest[0],'utf8'));
  return console.log(JSON.stringify(await request('fill',{fields:job.fields}),null,2));
 }
 if(command==='queue')return console.log(JSON.stringify(await queueAction(rest[1],rest[0],{allowSubmit:rest.includes('--allow-submit')}),null,2));
 console.log('effigy assist status | snapshot | pause | fill <job.json> | queue <status|prepare|reconcile|submit> <queue.json> [--allow-submit]');
}
