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

npx --yes skills add "$source_dir" --skill review --agent codex --yes
test -e .agents/skills/review/SKILL.md
test -f skills-lock.json
./node_modules/.bin/skilloom setup "$acceptance_root" --depth 1 --machine-name "Project acceptance" --json | tee "$acceptance_root/setup.json"
node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(data.adoption.adopted!==1||data.inventory.discovery.projectsFound!==1) process.exit(1)' "$acceptance_root/setup.json"
./node_modules/.bin/skilloom plan --all --check --json | tee "$acceptance_root/converged.json"
./node_modules/.bin/skilloom remove review --from project:project --json

cat > .skilloom.yaml <<YAML
version: 1
skills:
  - source: $source_dir
    name: lint
    agents: [codex]
YAML
./node_modules/.bin/skilloom sync --dry-run --json | tee "$acceptance_root/preview.json"
test -e .agents/skills/review/SKILL.md
test ! -e .agents/skills/lint
./node_modules/.bin/skilloom sync --yes --json | tee "$acceptance_root/transition.json"
test -e .agents/skills/lint/SKILL.md
test ! -e .agents/skills/review
npx --yes skills list --json | tee "$acceptance_root/upstream-list.json"
node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(data.length!==1||data[0].name!=="lint") process.exit(1)' "$acceptance_root/upstream-list.json"
./node_modules/.bin/skilloom sync --yes --json | tee "$acceptance_root/no-op.json"
node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(data.completed.length!==0||!data.converged) process.exit(1)' "$acceptance_root/no-op.json"

# A previously managed installation becomes repository-owned when Git tracks it.
git add .agents/skills/lint
./node_modules/.bin/skilloom project remove --skill lint --json
./node_modules/.bin/skilloom sync --yes --json | tee "$acceptance_root/tracked.json"
test -e .agents/skills/lint/SKILL.md
node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(data.completed.length!==0||!data.converged) process.exit(1)' "$acceptance_root/tracked.json"

echo "Real project-scope acceptance passed with skills $(npx --yes skills --version)."
