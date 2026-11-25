#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const id=fs.readFileSync(path.join(repo,'native/extension-id.txt'),'utf8').trim();
const option=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
const root=option('--root')||path.join(os.homedir(),'.effigy','assist');
const destination=option('--manifest-dir')||path.join(os.homedir(),'Library/Application Support/Google/Chrome/NativeMessagingHosts');
if(process.platform!=='darwin'&&!option('--manifest-dir'))throw new Error('Specify --manifest-dir for this platform');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
fs.mkdirSync(root,{recursive:true,mode:0o700});
fs.mkdirSync(destination,{recursive:true});
const launcher=path.join(root,'native-host.sh');
fs.writeFileSync(launcher,`#!/bin/sh\nexport EFFIGY_ASSIST_DIR=${quote(root)}\nexec ${quote(process.execPath)} ${quote(path.join(repo,'native/host.mjs'))}\n`,{mode:0o700});
const manifest={name:'com.effigy.assist',description:'Effigy local tab assistance',path:launcher,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]};
fs.writeFileSync(path.join(destination,'com.effigy.assist.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({extension:path.join(repo,'extension'),extensionId:id,manifest:path.join(destination,'com.effigy.assist.json'),root},null,2));
