// Runs in the isolated content-script world, top frame only. No page eval or token access.
export async function pageCommand(command,args,expectedOrigin) {
 try {
 if(expectedOrigin && location.origin!==expectedOrigin)throw new Error('Tab changed origin during command');
 const visible=e=>Boolean(e.getClientRects().length)&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
 const challenge=()=>Array.from(document.querySelectorAll('iframe[src*="challenges.cloudflare.com"], [data-effigy-challenge], [role="dialog"]')).some(e=>visible(e)&&(e.tagName==='IFRAME'||e.hasAttribute('data-effigy-challenge')||/verify you are human|security verification/i.test(e.textContent)));
 const check=()=>{if(challenge())throw new Error('Human verification is visible; assistance paused. Complete it yourself.');};
 const locate=spec=>{
  if(typeof spec.selector!=='string'||spec.selector.length>1000)throw new Error('Invalid selector');
  const found=Array.from(document.querySelectorAll(spec.selector));
  if(spec.index===undefined&&found.length!==1)throw new Error(`Expected one field, found ${found.length}: ${spec.selector}`);
  const el=found[spec.index??0];
  if(!el)throw new Error(`Missing field: ${spec.selector}`);
  if(el.closest('iframe')||el.matches('input[type=password],input[type=file]'))throw new Error('Sensitive controls are not supported');
  return el;
 };
 const read=el=>el.getAttribute('role')==='slider'?el.getAttribute('aria-valuenow'):(el.isContentEditable?el.textContent:el.value);
 check();
 if(command==='snapshot') {
  return {url:location.href,title:document.title,fields:(args.fields||[]).map(spec=>({selector:spec.selector,value:read(locate(spec))})),songs:Array.from(new Map(Array.from(document.querySelectorAll('a[href*="/song/"]')).filter(e=>new URL(e.href).origin===location.origin).map(e=>[e.href,{title:e.textContent,url:e.href}])).values()).slice(0,100)};
 }
 if(command==='fill') {
  if(!Array.isArray(args.fields)||args.fields.length>20)throw new Error('Expected at most 20 fields');
  // Resolve and validate everything first. Partial DOM updates can still happen; caller must not submit on failure.
  const fields=args.fields.map(spec=>{
   const el=locate(spec);
   if(!['INPUT','TEXTAREA'].includes(el.tagName)&&!el.isContentEditable&&el.getAttribute('role')!=='slider')throw new Error('Unsupported field');
   if(typeof spec.value!=='string'||spec.value.length>10000)throw new Error('Invalid field value');
   return {spec,el};
  });
  for(const {spec,el} of fields) {
   check();
   if(read(el)===spec.value)continue;
   if(el.disabled||el.readOnly)throw new Error('Field is disabled or read-only');
   if(el.getAttribute('role')==='slider') {
    const target=Number(spec.value),min=Number(el.getAttribute('aria-valuemin')),max=Number(el.getAttribute('aria-valuemax'));
    if(!Number.isFinite(target)||target<min||target>max)throw new Error('Slider target out of range');
    el.focus();
    for(let i=0;i<300&&Number(read(el))!==target;i++){
     const old=Number(read(el)),key=old<target?'ArrowRight':'ArrowLeft';
     el.dispatchEvent(new KeyboardEvent('keydown',{key,code:key,bubbles:true}));
     el.dispatchEvent(new KeyboardEvent('keyup',{key,code:key,bubbles:true}));
     await new Promise(r=>setTimeout(r,5));
     if(Number(read(el))===old)throw new Error('Slider did not respond; no submission performed');
    }
   } else if(el.isContentEditable) {
    el.focus();
    const range=document.createRange();range.selectNodeContents(el);
    const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    // Use the browser editing operation so rich-text editors receive editing events.
    if(!document.execCommand(spec.value?'insertText':'delete',false,spec.value))throw new Error('Rich-text editor did not accept edit');
   } else {
    const prototype=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype,'value').set.call(el,spec.value);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
   }
   await new Promise(r=>setTimeout(r,30));
   if(read(el)!==spec.value)throw new Error(`Field readback mismatch: ${spec.selector}`);
  }
  // Verify the current nodes again; React may replace them following input events.
  const values=args.fields.map(spec=>({selector:spec.selector,value:read(locate(spec))}));
  if(values.some((v,i)=>v.value!==args.fields[i].value))throw new Error('Final form readback mismatch');
  return {filled:values};
 }
 if(command==='click') {
  const el=locate(args);
  if(!visible(el)||el.disabled||el.getAttribute('aria-disabled')==='true')throw new Error('Target is not available');
  if(!el.matches('button,[role=button],[role=menuitem]'))throw new Error('Only buttons and menu actions are supported');
  el.click();
  return {dispatched:true}; // This is not confirmation that the server accepted anything.
 }
 throw new Error('Unsupported page command');
 } catch(error) { return {__effigyError:String(error.message||error)}; }
}
