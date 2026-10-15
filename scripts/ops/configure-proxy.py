"""Add only Relakeep's location to the existing API virtual host."""
from pathlib import Path
import shutil
import subprocess

path = Path('/etc/nginx/conf.d/anciya-api.conf')
original = path.read_text()
marker = '    location ^~ /relakeep/ {'
if marker not in original:
    backup = Path('/opt/relakeep/nginx-before-relakeep.conf')
    if not backup.exists():
        shutil.copy2(path, backup)
    location = '''    location ^~ /relakeep/ {
        access_log off;
        client_max_body_size 256k;
        proxy_pass http://127.0.0.1:4190/;
        proxy_http_version 1.1;
        proxy_set_header Host atlas.sayori.org;
        proxy_set_header X-Forwarded-Host atlas.sayori.org;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 150s;
        proxy_send_timeout 150s;
    }

'''
    assert original.count('    location ^~ /api/ {') == 1
    path.write_text(original.replace('    location ^~ /api/ {', location + '    location ^~ /api/ {'))
    result = subprocess.run(['nginx', '-t'], capture_output=True)
    if result.returncode:
        path.write_text(original)
        raise RuntimeError('Nginx validation failed; original config restored')
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
print('Relakeep HTTPS proxy configured')
