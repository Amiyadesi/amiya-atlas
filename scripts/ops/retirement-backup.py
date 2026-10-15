"""Recovery backup only. Credentials stay in server memory/private work files."""
import datetime
import json
import os
import pathlib
import re
import shutil
import subprocess
import tarfile
import zipfile

os.umask(0o077)
work = pathlib.Path('/opt/relakeep-retirement-work')
work.mkdir(mode=0o700, exist_ok=True)
client = '/usr/local/mysql/mysql5.7/bin/mysql'
dump = '/usr/local/mysql/mysql5.7/bin/mysqldump'
docker = ['/opt/docker-27.5.1/docker', '-H', 'unix:///run/docker-modern.sock']


def yaml_scalars(text):
    result, stack = {}, []
    for line in text.splitlines():
        match = re.match(r'^(\s*)([\w.-]+):\s*(.*?)\s*$', line)
        if not match:
            continue
        indent, name, value = len(match[1]), match[2], match[3]
        while stack and stack[-1][0] >= indent:
            stack.pop()
        path = '.'.join([part[1] for part in stack] + [name])
        if not value or value.startswith('#'):
            stack.append((indent, name))
        else:
            result[path] = value.strip('"\'')
    return result


jar = zipfile.ZipFile('/usr/local/anciya-api/anciya-service.jar')
config = {}
for name in ['BOOT-INF/classes/application.yml', 'BOOT-INF/classes/application-prod.yml']:
    config.update(yaml_scalars(jar.read(name).decode('utf8')))
prefixes = [key.rsplit('.', 1)[0] for key, value in config.items() if 'jdbc:mysql:' in value]
if not prefixes:
    raise RuntimeError('No MySQL datasource found in application config')
prefix = prefixes[0]
user = config.get(prefix + '.username')
password = config.get(prefix + '.password')
if user is None or password is None or '${' in user + password:
    raise RuntimeError('Datasource credential requires explicit server-side resolution')
options = work / 'mysql-client.cnf'


def quote_option(value):
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n') + '"'


options.write_text('[client]\nhost=127.0.0.1\nprotocol=TCP\nuser=' + quote_option(user) + '\npassword=' + quote_option(password) + '\n')
os.chmod(options, 0o600)


def sql(query):
    proc = subprocess.run([client, '--defaults-extra-file=' + str(options), '--batch', '--skip-column-names', '-e', query], capture_output=True)
    if proc.returncode:
        raise RuntimeError('MySQL metadata query failed; credentials and stderr withheld')
    return proc.stdout.decode('utf8')


tables = sql("SELECT TABLE_SCHEMA,TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys') AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_SCHEMA,TABLE_NAME")
counts = []
for line in tables.splitlines():
    db, table = line.split('\t')
    qualified = '`' + db.replace('`', '``') + '`.`' + table.replace('`', '``') + '`'
    counts.append({'database': db, 'table': table, 'rows': int(sql('SELECT COUNT(*) FROM ' + qualified).strip())})
(work / 'table-counts.json').write_text(json.dumps(counts))
with (work / 'mysql.sql').open('wb') as output:
    proc = subprocess.run([dump, '--defaults-extra-file=' + str(options), '--single-transaction', '--all-databases', '--routines', '--events', '--triggers', '--hex-blob', '--set-gtid-purged=OFF'], stdout=output, stderr=subprocess.PIPE)
    if proc.returncode:
        raise RuntimeError('mysqldump failed; original services retained')
n8n = json.loads(subprocess.check_output(docker + ['inspect', 'n8n']))
(work / 'n8n-inspect.json').write_text(json.dumps(n8n))
db_script = "import sqlite3; a=sqlite3.connect('file:/opt/n8n/data/database.sqlite?mode=ro',uri=True); b=sqlite3.connect('/opt/relakeep-retirement-work/n8n.sqlite'); a.backup(b); b.close(); a.close()"
subprocess.run(['/opt/xy-amiya-studio/venv/bin/python', '-c', db_script], check=True)
age = '/opt/relakeep-ops/bin/age'
recipient = pathlib.Path('/opt/relakeep-ops/recipient.txt').read_text().strip()
archive_dir = pathlib.Path('/opt/relakeep-backups/retired')
archive_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
name = 'retirement-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.tar.gz.age'
target = archive_dir / name
files = ['/usr/local/anciya-api', '/usr/local/java', '/etc/my.cnf', '/etc/init.d/mysql', '/etc/init.d/mysqld', '/etc/nginx', '/etc/systemd/system/n8n.service', '/opt/n8n/data', str(work)]
with target.open('wb') as output:
    encrypt = subprocess.Popen([age, '-r', recipient], stdin=subprocess.PIPE, stdout=output)
    with tarfile.open(fileobj=encrypt.stdin, mode='w|gz') as archive:
        for path in files:
            if os.path.exists(path):
                archive.add(path, arcname=path.lstrip('/'))
        root = pathlib.Path('/usr/local/mysql/mysql5.7')
        for path in root.iterdir():
            if path.name not in ['data', 'logs']:
                archive.add(str(path), arcname=str(path).lstrip('/'))
    encrypt.stdin.close()
    if encrypt.wait() != 0:
        raise RuntimeError('age encryption failed; original services retained')
print(json.dumps({'archive': str(target), 'bytes': target.stat().st_size, 'tables': len(counts), 'n8n_external_key_saved': any(e.startswith('N8N_ENCRYPTION_KEY=') for e in n8n[0]['Config']['Env'])}))
