import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, createReadStream, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';

const archive = process.argv[2];
if (!/^retirement-[\w-]+\.tar\.gz\.age$/.test(archive ?? '')) throw new Error('Pass the encrypted archive filename');
const local = resolve('_private/retirement', archive);
const remote = '/opt/relakeep-backups/retired/' + archive;
const args = ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6'];
const metadata = spawnSync('ssh', [...args, 'company-server-01', `stat -c %s ${remote}; sha256sum ${remote}`], { encoding: 'utf8' });
if (metadata.status) throw new Error('Backup metadata unavailable');
const [size, hashLine] = metadata.stdout.trim().split('\n');
const expected = hashLine.split(' ')[0];
const offset = existsSync(local) ? statSync(local).size : 0;
if (offset > Number(size)) throw new Error('Local copy exceeds source size');
if (offset < Number(size)) {
  console.log('Resuming encrypted download at ' + offset + ' of ' + size + ' bytes');
  const child = spawn('ssh', [...args, 'company-server-01', `dd if=${remote} iflag=skip_bytes skip=${offset} bs=1M status=none`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const done = new Promise((ok, fail) => { child.on('error', fail); child.on('close', c => c === 0 ? ok() : fail(new Error('Encrypted transfer interrupted; resume with the same command'))); });
  await Promise.all([pipeline(child.stdout, createWriteStream(local, { flags: 'a' })), done]);
}
const hash = createHash('sha256');
for await (const chunk of createReadStream(local)) hash.update(chunk);
if (hash.digest('hex') !== expected) throw new Error('Encrypted backup checksum mismatch; original remains untouched');
console.log('Complete encrypted download verified');
const child = spawn('ssh', [...args, 'sayori', `umask 077; cat > ${remote}.partial && mv ${remote}.partial ${remote}`], { stdio: ['pipe', 'ignore', 'pipe'] });
const done = new Promise((ok, fail) => { child.on('error', fail); child.on('close', c => c === 0 ? ok() : fail(new Error('Sayori copy failed'))); });
await Promise.all([pipeline(createReadStream(local), child.stdin), done]);
const check = spawnSync('ssh', [...args, 'sayori', `sha256sum ${remote}`], { encoding: 'utf8' });
if (check.status || check.stdout.split(' ')[0] !== expected) throw new Error('Sayori checksum mismatch');
console.log('Full encrypted backup on Sayori verified');
