#!/usr/bin/env bash
set -euo pipefail
repository_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repository_root"
npm run build >/dev/null
python3 scripts/pty-smoke.py
