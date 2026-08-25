#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
PI_AGENT_DIR="${PI_AGENT_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}"
SHARED_SKILLS_DIR="${SHARED_SKILLS_DIR:-$HOME/.agents/skills}"

if [[ -z "$TARGET" ]]; then
  printf 'Usage: %s /path/to/project\n' "$0" >&2
  exit 64
fi

TARGET="$(mkdir -p -- "$TARGET" && cd -- "$TARGET" && pwd)"

# Project-scoped resources are always copied.
# cp -a preserves hidden files and keeps existing project files intact.
cp -a "$ROOT_DIR/.pi" "$TARGET/"

# The repository also contains snapshots of resources that are normally global.
# Materialize those into the project only when the current device does not
# already provide the same resource globally. This makes the script portable:
# existing global resources do not collide, while a new device gets everything.
copy_global_extension_or_theme() {
  local kind="$1"
  local source_root="$ROOT_DIR/global-agent/$kind"
  local target_root="$TARGET/.pi/$kind"
  local global_root="$PI_AGENT_DIR/$kind"

  [[ -d "$source_root" ]] || return 0
  while IFS= read -r -d '' source; do
    local relative="${source#"$source_root/"}"
    local global="$global_root/$relative"
    local target="$target_root/$relative"
    if [[ -e "$global" ]]; then
      # Clean up a copy left by an older version of this repository. A differing
      # project copy would still collide, so fail instead of leaving an
      # ambiguous configuration or silently deleting user-owned code.
      if [[ -e "$target" ]]; then
        if cmp -s "$source" "$target"; then
          rm -f -- "$target"
        else
          printf 'Conflict: %s exists globally and differs from %s. Remove or rename the project copy, then rerun.\n' "$relative" "$target" >&2
          return 1
        fi
      fi
      continue
    fi
    mkdir -p -- "$(dirname -- "$target")"
    cp -a "$source" "$target"
  done < <(find "$source_root" -type f -print0)
}

copy_global_skills_if_missing() {
  local source_root="$ROOT_DIR/global-agent/skills"
  local target_root="$TARGET/.agents/skills"
  [[ -d "$source_root" ]] || return 0

  while IFS= read -r -d '' marker; do
    local relative="${marker#"$source_root/"}"
    local skill_relative="${relative%/SKILL.md}"
    local source="$source_root/$skill_relative"
    local target="$target_root/$skill_relative"
    local shared="$SHARED_SKILLS_DIR/$skill_relative"
    local pi_shared="$PI_AGENT_DIR/skills/$skill_relative"

    # Also respect an already-present target/ancestor copy. Pi's project skill
    # discovery is hierarchical, so a target-local copy can collide too.
    if [[ -f "$shared/SKILL.md" || -f "$pi_shared/SKILL.md" ]]; then
      # Clean up an exact repository copy when a global copy wins. A differing
      # project copy would still collide, so fail rather than deleting it.
      if [[ -e "$target" ]]; then
        if diff -qr -- "$source" "$target" >/dev/null 2>&1; then
          rm -rf -- "$target"
        else
          printf 'Conflict: skill %s exists globally and differs from %s. Remove or rename the project copy, then rerun.\n' "$skill_relative" "$target" >&2
          return 1
        fi
      fi
      continue
    fi

    # A target-local skill is already enough; do not overwrite it on reruns.
    if [[ -f "$target/SKILL.md" ]]; then
      continue
    fi
    mkdir -p -- "$(dirname -- "$target")"
    cp -a "$source" "$target"
  done < <(find "$source_root" -type f -name SKILL.md -print0)
}

copy_global_extension_or_theme extensions
copy_global_extension_or_theme themes
copy_global_skills_if_missing

printf 'Copied portable pi configuration to %s\n' "$TARGET"
printf 'Project resources were installed; existing global resources were not duplicated.\n'
