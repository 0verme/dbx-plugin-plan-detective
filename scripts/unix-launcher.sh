#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "Plan Detective AI tools require Node.js 22 or newer." >&2
  exit 127
fi
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Plan Detective AI tools require Node.js 22 or newer." >&2
  exit 127
fi
exec node "$SCRIPT_DIR/../../backend/plan-detective-runtime.mjs" "$@"
