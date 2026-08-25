#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${PI_AGENT_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}"
TARGET="$TARGET_DIR/models.json"
FORCE=0

if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
elif [[ "${1:-}" != "" ]]; then
  printf 'Usage: %s [--force]\n' "$0" >&2
  exit 64
fi

mkdir -p -- "$TARGET_DIR"
if [[ -e "$TARGET" && "$FORCE" -ne 1 ]]; then
  if cmp -s "$ROOT_DIR/config/models.json" "$TARGET"; then
    printf 'Already up to date: %s\n' "$TARGET"
    exit 0
  fi
  printf 'Refusing to overwrite existing %s. Use --force after backing it up.\n' "$TARGET" >&2
  exit 1
fi

if [[ -e "$TARGET" ]]; then
  backup="$TARGET.backup.$(date +%Y%m%d%H%M%S)"
  cp -a "$TARGET" "$backup"
  printf 'Backed up existing models.json to %s\n' "$backup"
fi

cp -a "$ROOT_DIR/config/models.json" "$TARGET"
printf 'Installed model registry snapshot at %s\n' "$TARGET"
