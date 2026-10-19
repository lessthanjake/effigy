#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {encode,decoder} from './protocol.mjs';
import {assistRoot,socketPath} from '../lib/native-client.mjs';
const root=assistRoot(), endpoint=socketPath();
fs.mkdirSync(root,{recursive:true,mode:0o700});
fs.chmodSync(root,0o700);
const pending=new Map();
let active=false, owned=false;
const allowed=new Set(['status','snapshot','fill','click','pause']);
function respond(socket,message) { if(!socket.destroyed) socket.end(encode(message)); }
const server=net.createServer(socket=>{
  let received=false;
  socket.on('error',()=>{});
  socket.on('data',decoder(message=>{
    if(received) return socket.destroy();
    received=true;
    const {id,command,args}=message;
    if(typeof id!=='string'||id.length>80||!allowed.has(command)||!args||typeof args!=='object') return respond(socket,{id,ok:false,error:'Invalid command'});
    if(active) return respond(socket,{id,ok:false,error:'Another command is in progress'});
    active=true;
    const timer=setTimeout(()=>{
      pending.delete(id); active=false;
      respond(socket,{id,ok:false,error:'Extension timeout; check page before repeating actions'});
    },18000);
    pending.set(id,{socket,timer});
    process.stdout.write(encode(message));
  },()=>socket.destroy()));
});
process.stdin.on('data',decoder(message=>{
  const item=pending.get(message.id);
  if(!item) return;
  clearTimeout(item.timer);pending.delete(message.id);active=false;
  respond(item.socket,message);
},()=>process.exit(1)));
function stop(){
 for(const {socket,timer} of pending.values()){clearTimeout(timer);socket.destroy();}
 server.close();
 if(owned) try{fs.unlinkSync(endpoint);}catch{}
 process.exit(0);
}
process.stdin.on('end',stop);
process.on('SIGTERM',stop);process.on('SIGINT',stop);
process.on('exit',()=>{if(owned)try{fs.unlinkSync(endpoint);}catch{}});
// A second Chrome profile must never steal an existing connection.
if(fs.existsSync(endpoint)) {
 const live=await new Promise(resolve=>{
  const probe=net.createConnection(endpoint);probe.on('connect',()=>{probe.destroy();resolve(true);});
  probe.on('error',error=>resolve(error.code!=='ECONNREFUSED'&&error.code!=='ENOENT'));
 });
 if(live){console.error('Effigy Assist already connected in another browser/profile');process.exit(1);}
 fs.unlinkSync(endpoint);
}
server.on('error',error=>{console.error(error.message);process.exit(1);});
server.listen(endpoint,()=>{owned=true;fs.chmodSync(endpoint,0o600);});
