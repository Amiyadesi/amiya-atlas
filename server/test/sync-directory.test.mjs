import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {verifySyncTicket} from '../dist/sync-identity.js';
const directory=mkdtempSync(join(tmpdir(),'relakeep-directory-'));
Object.assign(process.env,{NODE_ENV:'test',RELAKEEP_NO_LISTEN:'true',PUBLIC_ORIGIN:'http://localhost:4190',DATA_DIR:directory,BETTER_AUTH_SECRET:'synthetic-auth-secret-at-least-32-characters',CACHE_KEY:'77'.repeat(32),PROXY_SECRET:'synthetic-proxy-secret-at-least-32-characters',BILLING_ENABLED:'false',CLOUD_ENABLED:'false'});
const {app,ledger}=await import('../dist/app.js'), db=ledger.db;
function user(email){const id=randomUUID(),token=randomUUID(),now=Date.now();db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run(id,'Fixture',email,1,now,now);db.prepare('INSERT INTO session(id,token,userId,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)').run(randomUUID(),token,id,now+60000,now,now);return{id,token};}
const owner=user('owner@example.invalid'),other=user('other@example.invalid');
async function req(account,path,body){const r=await app.request('http://localhost:4190/api/account/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','x-relakeep-proxy':process.env.PROXY_SECRET,Authorization:'Bearer '+account.token},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,value:await r.json()};}
test('same official account discovers own servers and obtains only its signed connection tickets',async()=>{
  const linked=await req(owner,'servers',{url:'https://personal.example',name:'Personal'});assert.equal(linked.status,200);const id=linked.value.serverId;
  assert.equal((await req(owner,'servers')).value.servers.length,1);assert.equal((await req(other,'servers')).value.servers.length,0);
  assert.equal((await req(other,'sync-ticket',{id})).status,404);
  const ticket=(await req(owner,'sync-ticket',{id})).value;
  assert.equal(verifySyncTicket(ticket.ticket,linked.value.publicKey,{url:'https://personal.example',serverId:id,userId:owner.id}).userId,owner.id);
  assert.equal((await req(owner,'servers',{url:'http://unsafe.example',name:'Unsafe'})).status,400);
  await req(other,'servers/remove',{id});assert.equal((await req(owner,'servers')).value.servers.length,1);
  await req(owner,'servers/remove',{id});assert.equal((await req(owner,'sync-ticket',{id})).status,404);
});
after(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
