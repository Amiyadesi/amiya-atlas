import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
const exe = resolve(process.argv[2] ?? "src-tauri/target/release/relakeep-web.exe");
const root = await mkdtemp(join(tmpdir(), "relakeep-sync-"));
const children = [];
let payload, tag, revision = 0, rejectWrite = false;
const remote = createServer(async (req, res) => {
  if (req.method === "GET") { res.writeHead(payload ? 200 : 404, payload ? { ETag: tag } : {}); res.end(payload); return; }
  if (rejectWrite || (payload ? req.headers["if-match"] !== tag : req.headers["if-none-match"] !== "*")) { res.writeHead(412); res.end(); return; }
  let text = ""; for await (const part of req) text += part; payload = text; tag = `"${++revision}"`; res.writeHead(204); res.end();
});
await new Promise(resolve => remote.listen(5503,"127.0.0.1",resolve));
async function start(port) {
  const child = spawn(exe, [], { env: { ...process.env, RELAKEEP_DATA_DIR: join(root,String(port)), RELAKEEP_BIND:`127.0.0.1:${port}`, RELAKEEP_ORIGIN:`http://localhost:${port}`, RELAKEEP_ACCESS_TOKEN:"temporary-access-key-for-sync-check" }, stdio:"ignore", windowsHide:true }); children.push(child);
  for(let i=0;i<80;i++) { try { const response=await fetch(`http://localhost:${port}/api/runtime`); if(response.ok) return; } catch {} await new Promise(resolve=>setTimeout(resolve,100)); }
  throw new Error("网页核心未启动");
}
async function call(port,command,args={}) {
  const response=await fetch(`http://localhost:${port}/api/invoke`,{method:"POST",headers:{Authorization:"Bearer temporary-access-key-for-sync-check","Content-Type":"application/json"},body:JSON.stringify({command,args})});
  const value=await response.json(); if(!value.ok) throw new Error(value.error); return value.data;
}
const config={kind:"webdav",url:"http://localhost:5503/vault.json",username:"fixture",password:"fixture-only",automatic:true};
try {
  await start(5501); await start(5502);
  await call(5501,"initialize_vault",{password:"fixture-vault-only-123"});
  await call(5501,"begin_text_capture",{text:"示例邮箱 A",inputType:"text"});
  await call(5501,"sync_configure",{config}); await call(5501,"sync_run");
  await call(5502,"import_backup",{payload,password:"fixture-vault-only-123"}); await call(5502,"sync_configure",{config}); await call(5502,"sync_run");
  await call(5501,"begin_text_capture",{text:"示例域名 B",inputType:"text"}); await call(5502,"begin_text_capture",{text:"示例电话 C",inputType:"text"});
  await call(5501,"sync_run"); await call(5502,"sync_run"); await call(5501,"sync_run");
  assert.equal((await call(5501,"load_snapshot")).captures.length,3);
  for(const port of [5501,5502]) {const snapshot=await call(port,"load_snapshot");snapshot.captures[0].rawText=`不同修改 ${port}`;await call(port,"save_snapshot",{snapshot,unlinkIds:[]});}
  await call(5501,"sync_run");const conflict=await call(5502,"sync_run");assert(conflict.conflicts.length);assert((await call(5502,"sync_status")).conflicts.length);
  await call(5502,"sync_run",{strategy:"remote"}); assert.equal((await call(5502,"load_snapshot")).captures[0].rawText,"不同修改 5501");
  const before=payload;await call(5502,"begin_text_capture",{text:"并发保护",inputType:"text"});rejectWrite=true;await assert.rejects(()=>call(5502,"sync_run"),/远端又有更新/);assert.equal(payload,before);rejectWrite=false;
  const broken=JSON.parse(payload);broken.records[0].ciphertext[0]^=1;payload=JSON.stringify(broken);await assert.rejects(()=>call(5501,"sync_run"),/篡改|认证|损坏/);
  assert(!(await readFile(join(root,"5501","atlas.sqlite"))).includes(Buffer.from("示例邮箱")));
  console.log("加密同步可用：独立修改合并、冲突确认、412 不覆盖、篡改拒绝。");
} finally {for(const child of children)child.kill();await new Promise(resolve=>remote.close(resolve));await new Promise(resolve=>setTimeout(resolve,300));await rm(root,{recursive:true,force:true});}
