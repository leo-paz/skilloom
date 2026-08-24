#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "$0")/.." && pwd)
acceptance_root=$(mktemp -d)
trap 'rm -rf "$acceptance_root"' EXIT

cd "$repository_root"
npm run build
tarball_name=$(npm pack --silent | tail -n 1)
tarball="$repository_root/$tarball_name"
trap 'rm -rf "$acceptance_root"; rm -f "$tarball"' EXIT

source_dir="$acceptance_root/source with spaces;argv"
project_dir="$acceptance_root/project"
isolated_home="$acceptance_root/home"
mkdir -p "$source_dir/review" "$source_dir/lint" "$project_dir" "$isolated_home/.codex"
cat > "$source_dir/review/SKILL.md" <<'SKILL'
---
name: review
description: Disposable Skilloom acceptance fixture.
---
# Review
SKILL
cat > "$source_dir/lint/SKILL.md" <<'SKILL'
---
name: lint
description: Second disposable Skilloom acceptance fixture.
---
# Lint
SKILL

git -C "$project_dir" init -q
npm --prefix "$project_dir" install --silent "$tarball"
export HOME="$isolated_home"
export XDG_CONFIG_HOME="$isolated_home/.config"
export CODEX_HOME="$isolated_home/.codex"
export npm_config_cache="$isolated_home/.npm"
cd "$project_dir"

./node_modules/.bin/skilloom init --yes --json
./node_modules/.bin/skilloom project init --json
cat > .skilloom.yaml <<YAML
version: 1
skills:
  - source: $source_dir
    name: review
    agents: [codex]
YAML

./node_modules/.bin/skilloom plan --check --json && exit 1 || test "$?" -eq 2
./node_modules/.bin/skilloom apply --yes --json | tee "$acceptance_root/first-apply.json"
test -e .agents/skills/review/SKILL.md
test -f skills-lock.json
./node_modules/.bin/skilloom plan --check --json | tee "$acceptance_root/converged.json"

cat > .skilloom.yaml <<YAML
version: 1
skills:
  - source: $source_dir
    name: lint
    agents: [codex]
YAML
./node_modules/.bin/skilloom apply --yes --json | tee "$acceptance_root/transition.json"
test -e .agents/skills/lint/SKILL.md
test ! -e .agents/skills/review
npx --yes skills list --json | tee "$acceptance_root/upstream-list.json"
node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(data.length!==1||data[0].name!=="lint") process.exit(1)' "$acceptance_root/upstream-list.json"
./node_modules/.bin/skilloom apply --yes --json | tee "$acceptance_root/no-op.json"
node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(data.completed.length!==0||!data.converged) process.exit(1)' "$acceptance_root/no-op.json"

echo "Real project-scope acceptance passed with skills $(npx --yes skills --version)."
