import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'relakeep-connected-'));
const origin='http://127.0.0.1:15151',password='fixture-password-only';
const child=spawn(process.execPath,['server/dist/selfhost.js'],{env:{...process.env,RELAKEEP_PORT:'15151',RELAKEEP_CORE_PORT:'15152',RELAKEEP_DATA_DIR:dir,RELAKEEP_ORIGIN:origin,BETTER_AUTH_SECRET:'fixture-only-secret-not-for-production',RELAKEEP_SETUP_TOKEN:'fixture-only-setup-not-for-production',RELAKEEP_WEB_BIN:resolve('src-tauri/target/release/relakeep-web.exe')},stdio:['ignore','ignore','pipe'],windowsHide:true});
const otherOrigin='http://127.0.0.1:15153',otherToken='fixture-only-second-vault-access-token';
const second=spawn(resolve('src-tauri/target/release/relakeep-web.exe'),[],{env:{...process.env,RELAKEEP_DATA_DIR:join(dir,'second'),RELAKEEP_BIND:'127.0.0.1:15153',RELAKEEP_ORIGIN:otherOrigin,RELAKEEP_ACCESS_TOKEN:otherToken},stdio:'ignore',windowsHide:true});
let errors='',cookie='';child.stderr.on('data',d=>errors+=d);
async function req(path,body,headers={}){
  const r=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  if(r.headers.getSetCookie().length)cookie=r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
  const text=await r.text();return{status:r.status,data:text?JSON.parse(text):null};
}
async function invoke(command,args={}){const r=await req('/api/invoke',{command,args});assert.equal(r.status,200);assert.equal(r.data.ok,true,r.data.error);return r.data.data;}
try{
  let ready=false;for(let i=0;i<500;i++){try{if((await fetch(origin+'/health')).ok){ready=true;break;}}catch{}if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,100));}assert(ready,`exit=${child.exitCode}; ${errors}`);
  assert.equal((await req('/api/setup',{email:'owner@example.invalid',password,setupToken:'fixture-only-setup-not-for-production'})).status,200);
  await invoke('initialize_vault',{password});
  let s=await invoke('begin_text_capture',{text:'fixture first vault'});
  const first=await invoke('export_backup');
  await invoke('sync_run');
  assert.equal((await req('/api/sync')).status,200);
  s=await invoke('begin_text_capture',{text:'fixture second note'});
  assert.equal(s.captures.length,2);
  const restored=await invoke('import_backup',{payload:first,password});
  assert.equal(restored.captures.length,1);assert(!restored.restoreWarning);
  assert.equal((await invoke('load_snapshot')).captures.length,1);
  assert.equal((await invoke('sync_run')).conflicts.length,0);
  async function secondInvoke(command,args={}){const r=await fetch(otherOrigin+'/api/invoke',{method:'POST',headers:{Authorization:'Bearer '+otherToken,'Content-Type':'application/json'},body:JSON.stringify({command,args})});const value=await r.json();assert.equal(value.ok,true,value.error);return value.data;}
  await secondInvoke('initialize_vault',{password});await secondInvoke('begin_text_capture',{text:'fixture entirely different vault'});
  const other=await secondInvoke('export_backup');
  await invoke('import_backup',{payload:other,password});
  assert.equal((await invoke('load_snapshot')).captures[0].rawText,'fixture entirely different vault');
  assert.equal((await invoke('sync_run')).conflicts.length,0);
  assert.equal((await invoke('cloud_status')).connected,false);
  const result=await req('/api/invoke',{command:'cloud_request',args:{path:'/api/account/ai',body:{}}});
  assert.equal(result.data.ok,false);assert.match(result.data.error,/登录官网/);
  const created=await req('/api/security/sync-keys',{name:'fixture phone'});assert.equal(created.status,200);const {token,id}=created.data;
  const listing=await req('/api/security/sync-keys');assert.equal(listing.data.keys.length,1);assert(!JSON.stringify(listing.data).includes(token));
  assert.equal((await req('/api/security/sync-keys/revoke',{id})).status,200);
  const fresh=await req('/api/security/sync-keys',{name:'fixture key'});
  const ownerCookie=cookie;cookie='';
  assert.equal((await req('/api/sync',undefined,{Authorization:'Bearer '+fresh.data.token})).status,200);
  assert.equal((await req('/api/security/sync-keys',undefined,{Authorization:'Bearer '+fresh.data.token})).status,401);
  assert.equal((await req('/api/invoke',{command:'vault_status',args:{}},{Authorization:'Bearer '+fresh.data.token})).status,401);
  assert.equal((await req('/api/sync',undefined,{Authorization:'Bearer '+token})).status,401);
  assert.equal((await req('/api/sync')).status,401);
  cookie=ownerCookie;
  assert.equal((await req('/api/sync/connect',{ticket:'forged'})).status,403);
  console.log('通过：导入立即生效并更新同步副本、官网登录保护、密钥可撤销且仅限同步。');
}finally{second.kill();if(process.platform==='win32')spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});else child.kill();await new Promise(r=>setTimeout(r,600));await rm(dir,{recursive:true,force:true});}
