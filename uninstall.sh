#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
command -v pi >/dev/null 2>&1 || { echo "Error: pi is not available in PATH." >&2; exit 1; }

pi remove "$ROOT_DIR"
cat <<'EOF'
The local package was removed from Pi.
Global model/compaction defaults were left unchanged intentionally.
Backups, if created, are under ~/.pi/agent/backups/pi-deepseek-harness/.
EOF
