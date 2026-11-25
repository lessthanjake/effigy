import {test} from 'node:test';
import assert from 'node:assert/strict';
const handlers={},session={},local={};let text='',title='',connections=0,failStorage=false;
const event=name=>({addListener(fn){handlers[name]=fn;}});
globalThis.chrome={
 action:{setBadgeText:async x=>{text=x.text;},setBadgeBackgroundColor:async()=>{},setTitle:async x=>{title=x.title;},onClicked:event('click')},
 // The selected tab lives in storage.local so it survives an extension reload.
 storage:{session:{get:async()=>({...session}),set:async x=>Object.assign(session,x),remove:async k=>delete session[k]},local:{get:async()=>{if(failStorage)throw new Error('Storage is unavailable');return {...local};},set:async x=>Object.assign(local,x),remove:async k=>delete local[k]}},
 runtime:{connectNative(){connections++;return {onDisconnect:event('disconnect'),onMessage:event('message'),postMessage(){}};}},
 tabs:{onRemoved:event('removed'),query:async()=>[{id:1,url:'https://suno.com/create'}]},commands:{onCommand:event('command')},
 // Any optional permissions request is a regression: activeTab already grants access.
 permissions:{request(){assert.fail('Must not ask for optional permissions');}}
};
await import('../extension/background.js');
test('activation handles unsupported pages, connects using activeTab, pauses and reports errors',async()=>{
 await handlers.click({id:1,url:'chrome://extensions/'});assert.equal(text,'NO');assert.match(title,/open a Suno/);assert.equal(connections,0);
 await handlers.click({id:1,url:'https://suno.com/create'});assert.equal(text,'ON');assert.equal(connections,1);assert.equal(local.selection.origin,'https://suno.com');
 await handlers.click({id:1,url:'https://suno.com/create'});assert.equal(text,'OFF');assert.equal(local.selection,undefined);
 failStorage=true;
 const old=console.error;console.error=()=>{};
 try{await handlers.click({id:1,url:'https://suno.com/create'});}finally{console.error=old;}
 assert.equal(text,'ERR');assert.match(title,/Storage is unavailable/);assert.equal(local.lastError.message,'Storage is unavailable');
});
