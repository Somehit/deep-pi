#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SETTINGS_FILE="$AGENT_DIR/settings.json"
APPLY_DEFAULTS=1

usage() {
  cat <<'EOF'
Usage: ./install.sh [--no-defaults]

Installs this directory as a global local Pi package.

Options:
  --no-defaults  Register the package without changing the default provider,
                 model, compaction, retry, or image settings.
EOF
}

while (($#)); do
  case "$1" in
    --no-defaults) APPLY_DEFAULTS=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

command -v pi >/dev/null 2>&1 || { echo "Error: pi is not available in PATH." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Error: node is not available in PATH." >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "Error: npm is not available in PATH." >&2; exit 1; }

node "$ROOT_DIR/scripts/check-config.mjs"
echo "Installing the pinned OCR runtime locally..."
npm install --prefix "$ROOT_DIR" --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund
mkdir -p "$AGENT_DIR"

if [[ -f "$SETTINGS_FILE" ]]; then
  BACKUP_DIR="$AGENT_DIR/backups/pi-deepseek-harness"
  mkdir -p "$BACKUP_DIR"
  BACKUP_FILE="$BACKUP_DIR/settings-$(date +%Y%m%d-%H%M%S).json"
  cp -p "$SETTINGS_FILE" "$BACKUP_FILE"
  echo "Settings backup: $BACKUP_FILE"
fi

echo "Registering local Pi package: $ROOT_DIR"
pi install "$ROOT_DIR"

echo "Installing @alexanderfortin/pi-deepseek-usage..."
pi install npm:@alexanderfortin/pi-deepseek-usage || echo "Warning: @alexanderfortin/pi-deepseek-usage install failed" >&2

if (( APPLY_DEFAULTS )); then
  node "$ROOT_DIR/scripts/merge-settings.mjs" \
    "$SETTINGS_FILE" \
    "$ROOT_DIR/config/settings.json"
else
  echo "Skipped global DeepSeek defaults (--no-defaults)."
fi

AUTH_STATE="$(node - "$AGENT_DIR/auth.json" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
try {
  const auth = JSON.parse(fs.readFileSync(path, "utf8"));
  process.stdout.write(auth.deepseek ? "configured" : "missing");
} catch {
  process.stdout.write("missing");
}
NODE
)"

cat <<EOF

Installation complete.

Modes:
  /brainstorm [task]
  /plan [task]
  /build [task]
  /ferrari [task]
  /execute
  /scout [task]
  /review [focus]
  /mode

Cycle shortcut: Ctrl+Alt+M or F6
Configuration:  $ROOT_DIR/config/harness.json
Instructions:   $ROOT_DIR/instructions/
OCR skill:      /skill:ocr <image-path> [languages]
EOF

if [[ "$AUTH_STATE" != "configured" && -z "${DEEPSEEK_API_KEY:-}" ]]; then
  cat <<'EOF'

DeepSeek authentication was not detected.
Start Pi and run:
  /login deepseek
EOF
fi

cat <<'EOF'

Restart Pi after installation. While developing this package, use /reload after edits.
EOF
