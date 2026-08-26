#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "$0")/.." && pwd)
real_npx=$(command -v npx)
real_bunx=$(command -v bunx)
smoke_root=$(mktemp -d)
trap 'rm -rf "$smoke_root"' EXIT

cd "$repository_root"
npm run build
tarball_name=$(npm pack --silent | tail -n 1)
tarball="$repository_root/$tarball_name"
trap 'rm -rf "$smoke_root"; rm -f "$tarball"' EXIT

mkdir -p "$smoke_root/fake-bin"
cat > "$smoke_root/fake-bin/npx" <<'FAKE_NPX'
#!/usr/bin/env bash
if [[ "${2:-}" == "list" ]]; then
  printf '[]\n'
  exit 0
fi
if [[ "${2:-}" == "--version" ]]; then
  printf '1.5.23\n'
  exit 0
fi
exit 0
FAKE_NPX
chmod +x "$smoke_root/fake-bin/npx"

run_suite() {
  local runner=$1
  local project=$2
  local isolated_home=$3
  mkdir -p "$project" "$isolated_home/.codex"
  git -C "$project" init -q
  if [[ "$runner" == "node" ]]; then
    npm --prefix "$project" install --silent "$tarball"
    command=("$real_npx" --no-install skilloom)
  else
    cd "$project"
    bun add --silent "$tarball"
    cd "$repository_root"
    command=("$real_bunx" --bun skilloom)
  fi
  export HOME="$isolated_home"
  export XDG_CONFIG_HOME="$isolated_home/.config"
  export CODEX_HOME="$isolated_home/.codex"
  export PATH="$smoke_root/fake-bin:$PATH"
  cd "$project"
  "${command[@]}" --help
  "${command[@]}" --version
  "${command[@]}" setup "$project" --machine-name "Package smoke" --no-adopt --json
  "${command[@]}" inventory --json
  "${command[@]}" add review tdd --source acme/skills --to profile:default --json
  "${command[@]}" plan --all --json
  "${command[@]}" apply --all --yes --json
  "${command[@]}" observe --json
  "${command[@]}" doctor --json
  cd "$repository_root"
}

run_suite node "$smoke_root/node-project" "$smoke_root/node-home"
run_suite bun "$smoke_root/bun-project" "$smoke_root/bun-home"

echo "Package smoke passed with $tarball_name under Node and Bun."
