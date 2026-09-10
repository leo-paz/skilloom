#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "$0")/.." && pwd)
real_npx=$(command -v npx)
real_bunx=$(command -v bunx)
smoke_root=$(mktemp -d)
smoke_root=$(cd "$smoke_root" && pwd -P)
trap 'rm -rf "$smoke_root"' EXIT

cd "$repository_root"
npm run build
tarball_name=$(npm pack --silent | tail -n 1)
tarball="$repository_root/$tarball_name"
trap 'rm -rf "$smoke_root"; rm -f "$tarball"' EXIT

source_dir="$smoke_root/fixture-source"
mkdir -p "$source_dir/review" "$source_dir/tdd"
for skill in review tdd; do
  cat > "$source_dir/$skill/SKILL.md" <<SKILL
---
name: $skill
description: Disposable package smoke fixture.
---
# $skill
SKILL
done
git -C "$source_dir" init -q
git -C "$source_dir" add .
git -C "$source_dir" -c user.name=Skilloom -c user.email=skilloom@localhost commit -qm "Package smoke skills"

run_suite() (
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
  export npm_config_cache="$isolated_home/.npm"
  cd "$project"
  "${command[@]}" --help
  "${command[@]}" --version
  "${command[@]}" setup "$project" --machine-name "Package smoke" --no-adopt --json
  "${command[@]}" inventory --json
  "${command[@]}" sync --yes --json
  "${command[@]}" add review tdd --source "$source_dir" --to profile:default --json
  "${command[@]}" plan --all --json
  "${command[@]}" sync --dry-run --json
  "${command[@]}" apply --all --yes --json
  test -f "$isolated_home/.agents/skills/review/SKILL.md"
  test -f "$isolated_home/.agents/skills/tdd/SKILL.md"
  # Local upstream installs omit source metadata; prove the fixture contents before attribution.
  "${command[@]}" source verify review --source "$source_dir" --scope global --yes --json
  "${command[@]}" source verify tdd --source "$source_dir" --scope global --yes --json
  "${command[@]}" sync --yes --json | tee "$isolated_home/verified.json"
  node -e 'const fs=require("fs");const result=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!result.converged||result.completed.length)process.exit(1)' "$isolated_home/verified.json"
  "${command[@]}" observe --json
  "${command[@]}" doctor --json
  ln -s "$isolated_home/unavailable-skill" "$isolated_home/.agents/skills/missing-fixture"
  "${command[@]}" doctor --installations --json > "$isolated_home/installation-checks.json"
  node -e 'const fs=require("fs");const result=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const link=process.argv[2];if(!result.ok||!result.installations.complete||!result.installations.entries.some(e=>e.path===link&&e.status==="target-missing")||!fs.lstatSync(link).isSymbolicLink())process.exit(1)' "$isolated_home/installation-checks.json" "$isolated_home/.agents/skills/missing-fixture"
  cd "$repository_root"
)

run_suite node "$smoke_root/node-project" "$smoke_root/node-home"
run_suite bun "$smoke_root/bun-project" "$smoke_root/bun-home"

echo "Package smoke passed with $tarball_name under Node and Bun."
