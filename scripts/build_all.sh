#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

"$ROOT/scripts/configure_native.sh"
cmake --build "$ROOT/build" --target sviz_server -j "${JOBS:-8}"

if [ -f "$ROOT/.tools/emsdk/emsdk_env.sh" ]; then
  "$ROOT/scripts/configure_wasm.sh"
  cmake --build "$ROOT/build-wasm" --target sviz_wasm -j "${JOBS:-8}"
else
  echo "Skipping WASM build because Emscripten is not installed. Run scripts/setup_tools.sh."
fi
