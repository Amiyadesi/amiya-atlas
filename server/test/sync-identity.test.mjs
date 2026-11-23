import {test} from 'node:test';
import assert from 'node:assert/strict';
import {syncSigner,verifySyncTicket} from '../dist/sync-identity.js';
test('sync tickets bind server, official user and expiry, and reject tampering',()=>{
  const signer=syncSigner(Buffer.alloc(32,7)), now=Date.now();
  const binding={url:'https://personal.example',serverId:'server-one',userId:'owner-one'};
  const token=signer.issue({aud:binding.url,serverId:binding.serverId,userId:binding.userId,exp:now+60000,nonce:'a'.repeat(32)});
  assert.equal(verifySyncTicket(token,signer.publicKey,binding,now).userId,binding.userId);
  for(const changed of [{...binding,userId:'another'},{...binding,url:'https://other.example'},{...binding,serverId:'other'}])assert.throws(()=>verifySyncTicket(token,signer.publicKey,changed,now));
  assert.throws(()=>verifySyncTicket(token,signer.publicKey,binding,now+61000));
  assert.throws(()=>verifySyncTicket(token.slice(0,-6)+'broken',signer.publicKey,binding,now));
  assert.equal(syncSigner(Buffer.alloc(32,7)).publicKey,signer.publicKey);
});
