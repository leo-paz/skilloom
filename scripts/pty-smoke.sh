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
  if script --version 2>&1 | grep -q 'util-linux'; then
    output=$(printf '\033' | HOME="$pty_root/home" XDG_CONFIG_HOME="$pty_root/home/.config" CODEX_HOME="$pty_root/home/.codex" COLUMNS="$width" script -q -e -c "node dist/index.mjs" /dev/null 2>&1 || true)
  else
    output=$(printf '\033' | HOME="$pty_root/home" XDG_CONFIG_HOME="$pty_root/home/.config" CODEX_HOME="$pty_root/home/.codex" COLUMNS="$width" script -q /dev/null node dist/index.mjs 2>&1 || true)
  fi

  if [[ "$output" != *Skilloom* || "$output" != *"No changes made"* ]]; then
    printf 'PTY cancellation failed at %s columns. Output:\n%s\n' "$width" "$output" >&2
    return 1
  fi
}

run_width 100
run_width 40

echo "PTY cancellation passed at 100 and 40 columns."
