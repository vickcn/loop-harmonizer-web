#!/usr/bin/env bash
set -euo pipefail

WORK_ROOT="${WORK_ROOT:-${HOME:-/home/user}}"
PROJECT_NAME="${PROJECT_NAME:-loop-harmonizer-web}"
PROJECT_DIR=""
FALLBACK_DIR=""

if [ ! -d "$WORK_ROOT" ]; then
  WORK_ROOT="$PWD"
fi

git_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -n "$git_root" ] && [ -f "$git_root/package.json" ] && grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$PROJECT_NAME\"" "$git_root/package.json"; then
  PROJECT_DIR="$git_root"
fi

if [ -f "./package.json" ] && grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$PROJECT_NAME\"" "./package.json"; then
  PROJECT_DIR="$PWD"
fi

if [ -z "$PROJECT_DIR" ]; then
  while IFS= read -r package_json; do
    if grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$PROJECT_NAME\"" "$package_json"; then
      candidate_dir="$(dirname "$package_json")"
      if [ "$(basename "$candidate_dir")" = "$PROJECT_NAME" ]; then
        PROJECT_DIR="$candidate_dir"
        break
      fi
      if [ -d "$candidate_dir/.git" ]; then
        PROJECT_DIR="$candidate_dir"
        break
      fi
      if [ -z "$FALLBACK_DIR" ]; then
        FALLBACK_DIR="$candidate_dir"
      fi
    fi
  done < <(find "$WORK_ROOT" -maxdepth 4 -type f -name package.json 2>/dev/null)
fi

if [ -z "$PROJECT_DIR" ]; then
  if [ -n "$FALLBACK_DIR" ]; then
    PROJECT_DIR="$FALLBACK_DIR"
  fi
fi

if [ -z "$PROJECT_DIR" ]; then
  first_package_json="$(find "$WORK_ROOT" -maxdepth 4 -type f -name package.json 2>/dev/null | head -n 1 || true)"
  if [ -n "$first_package_json" ]; then
    PROJECT_DIR="$(dirname "$first_package_json")"
  fi
fi

if [ -z "$PROJECT_DIR" ] || [ ! -f "$PROJECT_DIR/package.json" ]; then
  echo "[setup] 找不到 package.json，請確認 repo 已 checkout 到 $WORK_ROOT 之下。" >&2
  exit 254
fi

echo "[setup] project: $PROJECT_DIR"
cd "$PROJECT_DIR"

npm ci

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  npm run build
fi

echo "[setup] done"
