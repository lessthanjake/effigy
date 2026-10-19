import {pageCommand} from './page.js';
const HOST='com.effigy.assist';
let port=null,busy=false;
export function permitted(url) {
 try {const u=new URL(url);return u.origin==='https://suno.com'||(u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname));} catch{return false;}
}
const badge=(text,color='#30643b')=>{chrome.action.setBadgeText({text});chrome.action.setBadgeBackgroundColor({color});};
async function selected() {
 const {selection}=await chrome.storage.session.get('selection');
 if(!selection)throw new Error('No selected tab. Click the Effigy icon on Suno or localhost.');
 const tab=await chrome.tabs.get(selection.tabId);
 if(!permitted(tab.url)||new URL(tab.url).origin!==selection.origin)throw new Error('Selected tab changed origin; select it again');
 return {tabId:tab.id,url:tab.url,origin:selection.origin};
}
export function connect() {
 if(port)return;
 const connection=chrome.runtime.connectNative(HOST);port=connection;
 connection.onDisconnect.addListener(()=>{
  const error=chrome.runtime.lastError?.message;
  port=null;badge('OFF','#944');
  chrome.action.setTitle({title:error?`Effigy disconnected: ${error}`:'Effigy disconnected; click to reconnect'});
 });
 connection.onMessage.addListener(async message=>{
  if(busy){connection.postMessage({id:message.id,ok:false,error:'Command already running'});return;}
  busy=true;
  try {
   const {command,args={}}=message;
   if(command==='pause') {
    await chrome.storage.session.remove('selection');badge('OFF');
    connection.postMessage({id:message.id,ok:true,result:{paused:true}});return;
   }
   const selection=await selected();
   let result;
   if(command==='status')result={connected:true,...selection};
   else {
    if(!['snapshot','fill','click'].includes(command))throw new Error('Unsupported command');
    const results=await chrome.scripting.executeScript({target:{tabId:selection.tabId},func:pageCommand,args:[command,args,selection.origin]});
    if(results.length!==1||results[0].error)throw new Error(results[0]?.error?.message||'Unexpected frame result');
    if(results[0].result===undefined)throw new Error('Page operation failed; inspect extension console');
    result=results[0].result;
    if(result?.__effigyError)throw new Error(result.__effigyError);
   }
   badge('ON');connection.postMessage({id:message.id,ok:true,result});
  } catch(error) {
   badge('WAIT','#956000');connection.postMessage({id:message.id,ok:false,error:String(error.message||error)});
  } finally{busy=false;}
 });
}
async function toggle(tab) {
 if(!tab?.id||!permitted(tab.url)){badge('NO','#944');return;}
 const {selection}=await chrome.storage.session.get('selection');
 if(selection?.tabId===tab.id&&port){await chrome.storage.session.remove('selection');badge('OFF');return;}
 const u=new URL(tab.url),pattern=u.origin==='https://suno.com'?'https://suno.com/*':`${u.protocol}//${u.hostname}/*`;
 const granted=await chrome.permissions.request({origins:[pattern]});
 if(!granted){badge('NO','#944');return;}
 await chrome.storage.session.set({selection:{tabId:tab.id,origin:u.origin}});
 connect();badge('ON');
 chrome.action.setTitle({title:'Effigy assisting this tab. Click to pause.'});
}
chrome.action.onClicked.addListener(tab=>{toggle(tab).catch(error=>{badge('ERR','#944');console.error(error.message);});});
chrome.commands.onCommand.addListener(async command=>{
 if(command==='toggle-assistance')await toggle((await chrome.tabs.query({active:true,currentWindow:true}))[0]);
});
chrome.tabs.onRemoved.addListener(async tabId=>{
 const {selection}=await chrome.storage.session.get('selection');
 if(selection?.tabId===tabId){await chrome.storage.session.remove('selection');badge('OFF');}
});
// Never regain control automatically after browser restart. The user selects a tab.
