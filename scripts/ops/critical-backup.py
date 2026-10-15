import os,pathlib,subprocess,tarfile
os.umask(0o077)
recipient=pathlib.Path('/opt/relakeep-ops/recipient.txt').read_text().strip()
target='/opt/relakeep-backups/retired/retirement-critical-20261013.tar.gz.age'
with open(target,'wb') as output:
 p=subprocess.Popen(['/opt/relakeep-ops/bin/age','-r',recipient],stdin=subprocess.PIPE,stdout=output)
 with tarfile.open(fileobj=p.stdin,mode='w|gz') as tar:
  for file in ['/opt/relakeep-retirement-work','/opt/n8n/data/config','/usr/local/anciya-api','/etc/my.cnf','/etc/nginx','/etc/init.d/mysql','/etc/init.d/mysqld','/etc/systemd/system/n8n.service']:
   if os.path.exists(file):tar.add(file,arcname=file.lstrip('/'))
 p.stdin.close()
 if p.wait()!=0:raise RuntimeError('age encryption failed')
print('Critical encrypted backup created: '+str(os.path.getsize(target))+' bytes')
