import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encode,decoder,MAX_BYTES} from '../native/protocol.mjs';
test('native framing handles split headers, UTF-8 and multiple messages',()=>{
 const found=[],errors=[];const feed=decoder(m=>found.push(m),e=>errors.push(e));
 const data=Buffer.concat([encode({text:'φ Ω 🎵'}),encode({ok:true})]);
 for(const byte of data)feed(Buffer.from([byte]));
 assert.deepEqual(found,[{text:'φ Ω 🎵'},{ok:true}]);assert.equal(errors.length,0);
});
test('oversize frames fail closed',()=>{
 const errors=[];const feed=decoder(()=>assert.fail('must not decode'),e=>errors.push(e));
 const header=Buffer.alloc(4);header.writeUInt32LE(MAX_BYTES+1);feed(header);feed(encode({ok:true}));assert.equal(errors.length,1);
});
