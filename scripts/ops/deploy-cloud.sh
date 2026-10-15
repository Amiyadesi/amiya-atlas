#!/bin/bash
set -euo pipefail
umask 077
root=/opt/relakeep
docker=(/opt/docker-27.5.1/docker -H unix:///run/docker-modern.sock)
version=${1:?Pass the version built from the reviewed source}
[[ "$version" =~ ^[a-zA-Z0-9._-]+$ ]] || exit 2
test -f "$root/server.env"
test -f "$root/releases/$version/server/Dockerfile"
cd "$root/releases/$version"
"${docker[@]}" build --memory=700m -f server/Dockerfile -t "relakeep:$version" .
if "${docker[@]}" inspect relakeep >/dev/null 2>&1; then
  "${docker[@]}" inspect --format '{{.Config.Image}}' relakeep > "$root/previous-image.txt"
  "${docker[@]}" stop relakeep >/dev/null
  "${docker[@]}" rm relakeep >/dev/null
fi
"${docker[@]}" run -d --name relakeep --restart unless-stopped --memory=512m --memory-swap=512m --cpus=1 --log-opt max-size=5m --log-opt max-file=2 --security-opt no-new-privileges --cap-drop ALL --read-only --tmpfs /tmp:rw,noexec,nosuid,size=96m --env-file "$root/server.env" -p 127.0.0.1:4190:4190 -v "$root/data:/data" -v "$root/backups:/backups" "relakeep:$version"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4190/health >/dev/null; then
    printf '%s\n' "$version" > "$root/current-version.txt"
    printf 'Relakeep backend healthy: %s\n' "$version"
    exit 0
  fi
  sleep 1
done
printf 'Health check failed. Use rollback-cloud.sh.\n' >&2
exit 1
