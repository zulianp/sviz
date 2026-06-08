#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TOOLS_DIR="$ROOT/.tools"
EMSDK_DIR="$TOOLS_DIR/emsdk"
EMSDK_VERSION="${EMSDK_VERSION:-latest}"

need_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required tool: $1" >&2
    exit 1
  fi
}

need_tool git
need_tool cmake
need_tool python3

mkdir -p "$TOOLS_DIR"

if [ ! -d "$EMSDK_DIR/.git" ]; then
  git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
else
  git -C "$EMSDK_DIR" pull --ff-only
fi

"$EMSDK_DIR/emsdk" install "$EMSDK_VERSION"
"$EMSDK_DIR/emsdk" activate "$EMSDK_VERSION"

echo "SVIZ tools are installed."
echo "Activate them with: . scripts/env.sh"
echo "Configure WASM with: scripts/configure_wasm.sh"
