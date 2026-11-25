import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {encode,decoder} from '../native/protocol.mjs';
export const assistRoot = () => process.env.EFFIGY_ASSIST_DIR || path.join(os.homedir(),'.effigy','assist');
export const socketPath = () => path.join(assistRoot(),'bridge.sock');
export function request(command, args = {}, timeout = 20000) {
  return new Promise((resolve,reject) => {
    const socket = net.createConnection(socketPath());
    const id = randomUUID();
    const timer = setTimeout(()=>finish(new Error('Bridge timeout; outcome may be unknown. Do not blindly repeat submission.')),timeout);
    function finish(error,value) { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); }
    socket.on('connect',()=>socket.write(encode({id,command,args})));
    socket.on('data',decoder(message=>{
      if(message.id!==id) return finish(new Error('Mismatched bridge response'));
      finish(message.ok ? null : new Error(message.error || 'Bridge command failed'),message.result);
    },finish));
    socket.on('error',error=>finish(new Error(`Effigy Assist is disconnected. Click its icon on the target tab. (${error.code})`)));
    socket.on('end',()=>finish(new Error('Bridge disconnected; check status before retrying.')));
  });
}
