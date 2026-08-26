#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "$0")/.." && pwd)
pty_root=$(mktemp -d)
trap 'rm -rf "$pty_root"' EXIT
mkdir -p "$pty_root/home/.codex" "$pty_root/workspace" "$pty_root/bin"
cat > "$pty_root/bin/npx" <<'FAKE_NPX'
#!/usr/bin/env bash
if [[ "${2:-}" == "list" ]]; then
  printf '[]\n'
  exit 0
fi
exit 0
FAKE_NPX
chmod +x "$pty_root/bin/npx"
cd "$repository_root"
npm run build >/dev/null
HOME="$pty_root/home" XDG_CONFIG_HOME="$pty_root/home/.config" CODEX_HOME="$pty_root/home/.codex" PATH="$pty_root/bin:$PATH" node dist/index.mjs setup "$pty_root/workspace" --machine-name "PTY Mac" --no-adopt --json >/dev/null

run_width() {
  local width=$1
  local output
  if script --version 2>&1 | grep -q 'util-linux'; then
    output=$({ sleep 1; printf '\003'; } | HOME="$pty_root/home" XDG_CONFIG_HOME="$pty_root/home/.config" CODEX_HOME="$pty_root/home/.codex" PATH="$pty_root/bin:$PATH" COLUMNS="$width" timeout 15s script -q -e -c "stty cols $width rows 40 2>/dev/null || true; node dist/index.mjs" /dev/null 2>&1 || true)
  else
    output=$({ sleep 1; printf '\003'; } | HOME="$pty_root/home" XDG_CONFIG_HOME="$pty_root/home/.config" CODEX_HOME="$pty_root/home/.codex" PATH="$pty_root/bin:$PATH" COLUMNS="$width" script -q /dev/null sh -c "stty cols $width rows 40 2>/dev/null || true; node dist/index.mjs" 2>&1 || true)
  fi

  if [[ "$output" != *Skilloom* || "$output" != *"PTY Mac"* || "$output" != *Machines* || "$output" != *Projects* || "$output" != *"Choose a view or action"* || "$output" != *"No changes made"* ]]; then
    printf 'PTY cancellation failed at %s columns. Output:\n%s\n' "$width" "$output" >&2
    return 1
  fi
}

run_width 100
run_width 40

echo "PTY cancellation passed at 100 and 40 columns."
