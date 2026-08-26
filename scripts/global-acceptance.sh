#!/usr/bin/env bash
set -euo pipefail

if [[ "${SKILLOOM_ALLOW_GLOBAL_ACCEPTANCE:-}" != "1" ]]; then
  echo "Refusing global acceptance without SKILLOOM_ALLOW_GLOBAL_ACCEPTANCE=1." >&2
  exit 2
fi

repository_root=$(cd "$(dirname "$0")/.." && pwd)
acceptance_root=$(mktemp -d)
trap 'rm -rf "$acceptance_root"' EXIT
isolated_home="$acceptance_root/home"
project_dir="$acceptance_root/project"
mkdir -p "$isolated_home/.codex" "$project_dir"

cd "$repository_root"
npm run build
tarball_name=$(npm pack --silent | tail -n 1)
tarball="$repository_root/$tarball_name"
trap 'rm -rf "$acceptance_root"; rm -f "$tarball"' EXIT
npm --prefix "$project_dir" install --silent "$tarball"

export HOME="$isolated_home"
export XDG_CONFIG_HOME="$isolated_home/.config"
export CODEX_HOME="$isolated_home/.codex"
export npm_config_cache="$isolated_home/.npm"
cd "$project_dir"
initial=$(npx --yes skills list --global --agent codex --json)
test "$initial" = "[]"
npx --yes skills add mattpocock/skills --skill tdd --global --agent codex --yes
test -e "$isolated_home/.agents/skills/tdd/SKILL.md"
./node_modules/.bin/skilloom setup "$project_dir" --machine-name "Isolated global acceptance" --json > "$acceptance_root/setup.json"
node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(data.adoption.adopted!==1||data.adoption.unmanaged!==0) { console.error(JSON.stringify(data.adoption)); process.exit(1) }' "$acceptance_root/setup.json"
machine_id=$(tr -d '\n' < "$isolated_home/.config/skilloom/machine-id")
grep -q 'name: tdd' "$isolated_home/.config/skilloom/config.yaml"
./node_modules/.bin/skilloom setup "$project_dir" --machine-name "Isolated global acceptance" --json > "$acceptance_root/setup-again.json"
node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(data.adoption.adopted!==0) process.exit(1)' "$acceptance_root/setup-again.json"
npx --yes skills list --global --agent codex --json > "$acceptance_root/global-list.json"
node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(data.length!==1||!data[0].path.startsWith(process.argv[2])) process.exit(1)' "$acceptance_root/global-list.json" "$isolated_home"
./node_modules/.bin/skilloom update --yes --json

cat > "$isolated_home/.config/skilloom/config.yaml" <<YAML
version: 1
storage: { mode: local }
profiles:
  default:
    skills:
      - source: $acceptance_root/missing-source
        name: missing
        agents: [codex]
machines:
  $machine_id: { profile: default }
YAML
set +e
./node_modules/.bin/skilloom apply --yes --json > "$acceptance_root/failure.out" 2>&1
failure_code=$?
set -e
test "$failure_code" -eq 4
grep -q '"pending"' "$acceptance_root/failure.out"

cat > "$isolated_home/.config/skilloom/config.yaml" <<YAML
version: 1
storage: { mode: local }
profiles:
  default: { skills: [] }
machines:
  $machine_id: { profile: default }
YAML
./node_modules/.bin/skilloom apply --yes --json
test ! -e "$isolated_home/.agents/skills/tdd"
test "$(npx --yes skills list --global --agent codex --json)" = "[]"

echo "Isolated real global-scope acceptance passed."
