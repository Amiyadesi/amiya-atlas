#!/bin/bash
set -euo pipefail
root=/opt/relakeep
docker=(/opt/docker-27.5.1/docker -H unix:///run/docker-modern.sock)
image=$(cat "$root/previous-image.txt")
[[ "$image" == relakeep:* ]] || exit 2
"${docker[@]}" stop relakeep >/dev/null
"${docker[@]}" rm relakeep >/dev/null
"${docker[@]}" run -d --name relakeep --restart unless-stopped --memory=512m --memory-swap=512m --cpus=1 --log-opt max-size=5m --log-opt max-file=2 --security-opt no-new-privileges --cap-drop ALL --read-only --tmpfs /tmp:rw,noexec,nosuid,size=96m --env-file "$root/server.env" -p 127.0.0.1:4190:4190 -v "$root/data:/data" -v "$root/backups:/backups" "$image"
curl --retry 10 --retry-connrefused --retry-delay 1 -fsS http://127.0.0.1:4190/health
