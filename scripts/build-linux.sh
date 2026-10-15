#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
npm ci --ignore-scripts
npm run tauri -- build --config src-tauri/tauri.linux.conf.json --bundles deb
cargo build --manifest-path src-tauri/Cargo.toml --release --no-default-features --features web-host --bin relakeep-web
