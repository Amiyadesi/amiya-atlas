#!/usr/bin/env python3
"""Forced SSH command: accept encrypted cloud backups or prune after 30 days."""
import hashlib
import os
from pathlib import Path
import re
import shlex
import sys
import tempfile
import time

os.umask(0o077)
root = Path('/opt/relakeep-backups/cloud').resolve(strict=True)
args = shlex.split(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
pattern = re.compile(r'relakeep-cloud-\d{8}T\d{6}Z\.tar\.gz\.age')
if args == ['prune']:
    cutoff = time.time() - 30 * 86400
    for path in root.iterdir():
        if pattern.fullmatch(path.name) and path.is_file() and not path.is_symlink() and path.stat().st_mtime < cutoff:
            path.unlink()
    print('Encrypted cloud backup retention applied')
elif len(args) == 2 and args[0] in ('store', 'sha256') and pattern.fullmatch(args[1]):
    target = root / args[1]
    if target.is_symlink():
        raise RuntimeError('Symlink rejected')
    if args[0] == 'sha256':
        digest = hashlib.sha256()
        with target.open('rb') as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
        print(digest.hexdigest())
    else:
        handle, temporary = tempfile.mkstemp(prefix='.incoming-', dir=root)
        digest = hashlib.sha256()
        try:
            with os.fdopen(handle, 'wb') as output:
                header = sys.stdin.buffer.read(len(b'age-encryption.org/v1\n'))
                if header != b'age-encryption.org/v1\n':
                    raise RuntimeError('Only age-encrypted archives are accepted')
                output.write(header)
                digest.update(header)
                while chunk := sys.stdin.buffer.read(1024 * 1024):
                    output.write(chunk)
                    digest.update(chunk)
                output.flush()
                os.fsync(output.fileno())
            if target.exists():
                raise RuntimeError('Backup filename already exists')
            os.rename(temporary, target)
            print(digest.hexdigest())
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
else:
    raise SystemExit('Only store, sha256 and prune commands are permitted')
