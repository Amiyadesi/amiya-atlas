import os
from pathlib import Path
import pwd
import re
import subprocess
import sys

os.umask(0o077)
public_key = sys.stdin.read().strip()
if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+ relakeep-encrypted-backup', public_key):
    raise RuntimeError('Unexpected SSH key')
try:
    user = pwd.getpwnam('relakeep-backup')
except KeyError:
    subprocess.run(['useradd', '--system', '--create-home', '--home-dir', '/var/lib/relakeep-backup', '--shell', '/bin/sh', 'relakeep-backup'], check=True)
    user = pwd.getpwnam('relakeep-backup')
Path('/usr/local/libexec').mkdir(mode=0o755, exist_ok=True)
subprocess.run(['install', '-o', 'root', '-g', 'root', '-m', '755', '/tmp/relakeep-backup-receiver.py', '/usr/local/libexec/relakeep-backup-receiver'], check=True)
directory = Path('/opt/relakeep-backups/cloud')
directory.mkdir(parents=True, exist_ok=True)
os.chown(directory.parent, 0, user.pw_gid)
os.chmod(directory.parent, 0o710)
os.chown(directory, user.pw_uid, user.pw_gid)
keys = Path(user.pw_dir) / '.ssh'
keys.mkdir(mode=0o700, exist_ok=True)
os.chown(keys, user.pw_uid, user.pw_gid)
authorization = keys / 'authorized_keys'
authorization.write_text('restrict,command="/usr/local/libexec/relakeep-backup-receiver" ' + public_key + '\n')
os.chmod(authorization, 0o600)
os.chown(authorization, user.pw_uid, user.pw_gid)
Path('/tmp/relakeep-backup-receiver.py').unlink()
print('Restricted encrypted backup receiver installed')
