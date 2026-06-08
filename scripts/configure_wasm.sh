#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# shellcheck disable=SC1091
. "$ROOT/scripts/env.sh"

if ! command -v emcmake >/dev/null 2>&1; then
  echo "emcmake not found. Run scripts/setup_tools.sh, then retry." >&2
  exit 1
fi

emcmake cmake -S "$ROOT" -B "$ROOT/build-wasm" \
  -DCMAKE_BUILD_TYPE="${CMAKE_BUILD_TYPE:-Release}" \
  -DSVIZ_BUILD_SERVER=OFF
