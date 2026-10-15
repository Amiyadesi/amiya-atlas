#!/bin/bash
set -euo pipefail
umask 077
root=/opt/relakeep
docker=(/opt/docker-27.5.1/docker -H unix:///run/docker-modern.sock)
file="relakeep-cloud-$(date -u +%Y%m%dT%H%M%SZ).tar.gz.age"
recipient=$(cat "$root/backup-recipient.txt")
"${docker[@]}" exec -e "BACKUP_RECIPIENT=$recipient" -e "BACKUP_FILE=/backups/$file" relakeep node dist/backup.js
test -s "$root/backups/$file"
# The dedicated Sayori key is restricted to this backup directory and command.
remote=(ssh -i "$root/backup-ssh-key" -p "${RELAKEEP_BACKUP_PORT:?Set the registered SSH port}" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$root/backup-known-hosts" -o ConnectTimeout=15 -o ServerAliveInterval=30 "${RELAKEEP_BACKUP_HOST:?Set backup SSH host}")
checksum=$(sha256sum "$root/backups/$file" | cut -d ' ' -f 1)
stored=$("${remote[@]}" "store $file" < "$root/backups/$file")
test "$stored" = "$checksum"
"${remote[@]}" prune
find "$root/backups" -maxdepth 1 -type f -name 'relakeep-cloud-*.tar.gz.age' -mtime +30 -delete
