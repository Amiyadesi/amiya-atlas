import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const privateDir = resolve('_private/retirement');
mkdirSync(privateDir, { recursive: true });
function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${program} failed (${result.status}): ${(result.stderr ?? '').slice(0, 800)}`);
  return result.stdout?.trim() ?? '';
}
const release = 'v1.3.2';
const windowsDir = join(privateDir, 'age');
if (!existsSync(join(windowsDir, 'age.exe'))) {
  const url = `https://github.com/FiloSottile/age/releases/download/${release}/age-${release}-windows-amd64.zip`;
  const reply = await fetch(url);
  if (!reply.ok) throw new Error(`age download ${reply.status}`);
  writeFileSync(join(privateDir, 'age.zip'), Buffer.from(await reply.arrayBuffer()));
  run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${join(privateDir, 'age.zip')}' -DestinationPath '${privateDir}' -Force`]);
}
const key = join(privateDir, 'backup-identity.txt');
if (!existsSync(key)) run(join(windowsDir, 'age-keygen.exe'), ['-o', key]);
const recipient = run(join(windowsDir, 'age-keygen.exe'), ['-y', key]);
writeFileSync(join(privateDir, 'recipient.txt'), recipient + '\n');
const ssh = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'company-server-01'];
run('ssh', [...ssh, `umask 077; mkdir -p /opt/relakeep-ops/bin /opt/relakeep-backups/retired; curl --fail --location --silent --show-error https://github.com/FiloSottile/age/releases/download/${release}/age-${release}-linux-amd64.tar.gz | tar -xz -C /opt/relakeep-ops; cp /opt/relakeep-ops/age/age /opt/relakeep-ops/bin/age; /opt/relakeep-ops/bin/age --version`]);
run('scp', [join(privateDir, 'recipient.txt'), 'company-server-01:/opt/relakeep-ops/recipient.txt']);
run('scp', ['scripts/ops/retirement-backup.py', 'company-server-01:/opt/relakeep-ops/retirement-backup.py']);
console.log(JSON.stringify({ prepared: true, privateKeyFile: key, remoteAgeVersion: release }));
