import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHmac } from "node:crypto";
const dir = await mkdtemp(join(tmpdir(), "relakeep-selfhost-"));
const origin = "http://localhost:5011";
const child = spawn(process.execPath,["server/dist/selfhost.js"],{env:{...process.env,RELAKEEP_DATA_DIR:dir,RELAKEEP_ORIGIN:origin,BETTER_AUTH_SECRET:"fixture-auth-secret-only-not-for-use",RELAKEEP_SETUP_TOKEN:"fixture-setup-code-only-not-for-use",RELAKEEP_WEB_BIN:resolve("src-tauri/target/release/relakeep-web.exe")},stdio:["ignore","ignore","pipe"],windowsHide:true});
let errors="",cookie="";child.stderr.on("data",data=>errors+=data);
async function request(path,body,options={}) {
  const response=await fetch(origin+path,{method:body===undefined?"GET":"POST",headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json",...options.headers},body:body===undefined?undefined:JSON.stringify(body)});
  const incoming=response.headers.getSetCookie().map(s=>s.split(";")[0]);
  if(incoming.length) {const cookies=new Map(cookie.split("; ").filter(Boolean).map(s=>[s.split("=")[0],s]));for(const value of incoming)cookies.set(value.split("=")[0],value);cookie=[...cookies.values()].join("; ");}
  return {status:response.status,value:await response.json()};
}
function totp(secret) {let bits="";for(const ch of secret.toUpperCase())bits+=("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(ch)).toString(2).padStart(5,"0");const key=Buffer.from(Array.from({length:Math.floor(bits.length/8)},(_,i)=>parseInt(bits.slice(i*8,i*8+8),2)));const step=Buffer.alloc(8);step.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const h=createHmac("sha1",key).update(step).digest();return String((h.readUInt32BE(h[19]&15)&0x7fffffff)%1000000).padStart(6,"0");}
try {
  let started=false;for(let i=0;i<500;i++){try{if((await fetch(origin+"/health")).ok){started=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert(started,`exit=${child.exitCode}; ${errors}`);
  assert.equal((await request("/api/auth/sign-up/email",{email:"blocked@example.invalid",password:"fixture-password-only",name:"Blocked"})).status,403);
  assert.equal((await request("/api/setup",{email:"owner@example.invalid",password:"fixture-password-only",setupToken:"fixture-setup-code-only-not-for-use"})).status,200);
  assert.equal((await request("/api/setup",{})).status,409);
  const vault=await request("/api/invoke",{command:"vault_status",args:{}});assert.equal(vault.status,200);assert.equal(vault.value.ok,true);assert.equal(vault.value.data.exists,false);
  const setup=await request("/api/auth/two-factor/enable",{password:"fixture-password-only"});assert.equal(setup.status,200);assert(setup.value.backupCodes?.length);const secret=new URL(setup.value.totpURI).searchParams.get("secret");assert.equal((await request("/api/auth/two-factor/verify-totp",{code:totp(secret)})).status,200);
  await request("/api/auth/sign-out",{});cookie="";
  const login=await request("/api/auth/sign-in/email",{email:"owner@example.invalid",password:"fixture-password-only"});assert.equal(login.value.twoFactorRedirect,true);assert(!(await request("/api/auth/get-session")).value);
  assert.equal((await request("/api/auth/two-factor/verify-totp",{code:totp(secret)})).status,200);
  const session=(await request("/api/auth/get-session")).value;assert(session.user);assert(!session.session.ipAddress);assert(!session.session.userAgent);
  const generated=await request("/api/auth/device/code",{client_id:"relakeep-sync"});assert.equal(generated.status,200,JSON.stringify({error:generated.value.error,message:generated.value.message,description:generated.value.error_description}));const device=generated.value;assert.equal((await request("/api/auth/device?user_code="+encodeURIComponent(device.user_code))).status,200);const approved=await request("/api/auth/device/approve",{userCode:device.user_code});assert.equal(approved.status,200,JSON.stringify({error:approved.value.error,message:approved.value.message,description:approved.value.error_description}));
  const token=(await request("/api/auth/device/token",{client_id:"relakeep-sync",device_code:device.device_code,grant_type:"urn:ietf:params:oauth:grant-type:device_code"})).value;assert(token.access_token);
  assert.equal((await fetch(origin+"/api/sync",{headers:{Authorization:"Bearer "+token.access_token}})).status,404);
  console.log("自建登录可用：首次设置、关闭注册、2FA 登录、设备授权、环境记录默认关闭。");
} finally {child.kill();await new Promise(resolve=>setTimeout(resolve,400));await rm(dir,{recursive:true,force:true});}
