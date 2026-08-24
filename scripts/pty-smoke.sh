#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "$0")/.." && pwd)
pty_root=$(mktemp -d)
trap 'rm -rf "$pty_root"' EXIT
mkdir -p "$pty_root/home/.codex"
cd "$repository_root"
npm run build >/dev/null

run_width() {
  local width=$1
  local output
  output=$(printf '\033' | HOME="$pty_root/home" XDG_CONFIG_HOME="$pty_root/home/.config" CODEX_HOME="$pty_root/home/.codex" COLUMNS="$width" script -q /dev/null node dist/index.mjs 2>&1 || true)
  printf '%s' "$output" | grep -q 'Skilloom'
  printf '%s' "$output" | grep -q 'No changes made'
}

run_width 100
run_width 40

echo "PTY cancellation passed at 100 and 40 columns."
