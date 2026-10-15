import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
const dir=resolve('_private/retirement');
const archive=process.argv[2]??'retirement-20261013T025204Z.tar.gz.age';
if(!/^retirement-[\w-]+\.tar\.gz\.age$/.test(archive)) throw new Error('Invalid archive filename');
function run(cmd,args,options={}) {
 const r=spawnSync(cmd,args,{encoding:'utf8',...options});
 if(r.status!==0) throw new Error(`${cmd} failed (${r.status}); details withheld`);
 return r.stdout.trim();
}
async function asyncRun(cmd,args) {
 const p=spawn(cmd,args,{stdio:['ignore','ignore','pipe']});
 await new Promise((ok,fail)=>{p.on('error',fail);p.on('close',code=>code===0?ok():fail(new Error(`${cmd} failed ${code}`)));});
}
const local=join(dir,archive);
async function sha256(file) {
 const hash=createHash('sha256'); for await(const chunk of createReadStream(file)) hash.update(chunk);
 return hash.digest('hex');
}
const expectedHash=run('ssh',['company-server-01','sha256sum /opt/relakeep-backups/retired/'+archive]).split(' ')[0];
if(!existsSync(local)||await sha256(local)!==expectedHash) await asyncRun('scp',['-q','-o','ServerAliveInterval=30','company-server-01:/opt/relakeep-backups/retired/'+archive,local]);
console.log('Encrypted backup downloaded');
run('ssh',['sayori','umask 077; mkdir -p /opt/relakeep-backups/retired']);
await asyncRun('scp',['-q',local,'sayori:/opt/relakeep-backups/retired/'+archive]);
const checksum=await sha256(local);
for(const host of ['company-server-01','sayori']) {
 const remote=run('ssh',[host,'sha256sum /opt/relakeep-backups/retired/'+archive]).split(' ')[0];
 if(remote!==checksum) throw new Error('Encrypted backup checksum mismatch');
}
console.log('Both encrypted copies verified');
const restore=join(dir,archive.replace('.tar.gz.age','-restore'));mkdirSync(restore,{recursive:true});
const decrypt=spawn(join(dir,'age/age.exe'),['-d','-i',join(dir,'backup-identity.txt'),local],{stdio:['ignore','pipe','pipe']});
const extract=spawn('tar',['-xzf','-','-C',restore,'opt/relakeep-retirement-work','opt/n8n/data/config'],{stdio:['pipe','ignore','pipe']});
decrypt.stdout.pipe(extract.stdin);
await Promise.all([decrypt,extract].map(p=>new Promise((ok,fail)=>{p.on('error',fail);p.on('close',c=>c===0?ok():fail(new Error('Authenticated decryption/extraction failed')));})));
const work=join(restore,'opt/relakeep-retirement-work');
const inspect=JSON.parse(readFileSync(join(work,'n8n-inspect.json'),'utf8'));
const savedKey=inspect[0].Config.Env.find(s=>s.startsWith('N8N_ENCRYPTION_KEY='));
if(!savedKey||savedKey.split('=').slice(1).join('=').length<16) throw new Error('n8n external key missing');
const sqlite=new Database(join(work,'n8n.sqlite'),{readonly:true});
if(sqlite.pragma('integrity_check',{simple:true})!=='ok') throw new Error('n8n SQLite integrity failed');
const workflows=sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_entity').get().n;
sqlite.close();
const expected=JSON.parse(readFileSync(join(work,'table-counts.json'),'utf8'));
writeFileSync(join(dir,'expected-counts.json'),JSON.stringify(expected));
run('scp',[join(work,'mysql-client.cnf'),'sayori:/opt/relakeep-backups/retired/test-client.cnf']);
run('ssh',['sayori','chmod 600 /opt/relakeep-backups/retired/test-client.cnf; docker run -d --rm --name relakeep-retirement-restore --network none --memory=384m --tmpfs /var/lib/mysql:rw,nosuid,size=512m -e MYSQL_ALLOW_EMPTY_PASSWORD=yes mysql:5.7']);
try {
 run('ssh',['sayori','for i in $(seq 1 60); do docker exec relakeep-retirement-restore mysqladmin --protocol=TCP -h127.0.0.1 ping --silent >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1']);
 run('ssh',['sayori','docker cp /opt/relakeep-backups/retired/test-client.cnf relakeep-retirement-restore:/tmp/test-client.cnf']);
 const input=readFileSync(join(work,'mysql.sql'));
 run('ssh',['sayori','docker exec -i relakeep-retirement-restore mysql -uroot'],{input:Buffer.concat([input,Buffer.from('\nFLUSH PRIVILEGES;\n')]),maxBuffer:1024*1024});
 const query=expected.map(t=>'SELECT '+JSON.stringify(t.database+'.'+t.table)+',COUNT(*) FROM `'+t.database.replaceAll('`','``')+'`.`'+t.table.replaceAll('`','``')+'`;').join('\n');
 const rows=run('ssh',['sayori','docker exec -i relakeep-retirement-restore mysql --defaults-extra-file=/tmp/test-client.cnf --batch --skip-column-names'],{input:query}).split('\n');
 if(rows.length!==expected.length || rows.some((row,i)=>Number(row.split('\t')[1])!==expected[i].rows)) throw new Error('Restored MySQL row counts differ');
 console.log('MySQL restore verified: '+expected.length+' tables');
} finally {
 run('ssh',['sayori','docker stop relakeep-retirement-restore >/dev/null; rm -f /opt/relakeep-backups/retired/test-client.cnf']);
}
const report={archive,sha256:checksum,mysqlTables:expected.length,n8nExternalKeySaved:true,n8nWorkflows:workflows,verifiedAt:new Date().toISOString(),sqliteIntegrity:'ok'};
writeFileSync(join(dir,'restore-report.json'),JSON.stringify(report,null,2));
console.log('Isolated restore and SQLite integrity verified; report saved');
