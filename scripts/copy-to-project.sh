#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"

if [[ -z "$TARGET" ]]; then
  printf 'Usage: %s /path/to/project\n' "$0" >&2
  exit 64
fi

TARGET="$(mkdir -p -- "$TARGET" && cd -- "$TARGET" && pwd)"

# cp -a preserves hidden files and keeps existing project files intact. Existing
# files in .pi/.agents are intentionally replaced by this snapshot.
cp -a "$ROOT_DIR/.pi" "$TARGET/"
cp -a "$ROOT_DIR/.agents" "$TARGET/"

printf 'Copied pi configuration to %s\n' "$TARGET"
printf 'Run pi from that project; resources are discovered automatically.\n'
