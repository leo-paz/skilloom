#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repository_root"
npm test
npm run typecheck
npm run lint
npm run build
npm pack --dry-run
bash scripts/package-smoke.sh
bash scripts/project-acceptance.sh
bash scripts/pty-smoke.sh
git diff --check
