#!/usr/bin/env sh

SVIZ_ENV_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export SVIZ_ROOT="$SVIZ_ENV_DIR"
export EMSDK="$SVIZ_ROOT/.tools/emsdk"

if [ -f "$EMSDK/emsdk_env.sh" ]; then
  export EMSDK_QUIET="${EMSDK_QUIET:-1}"
  # shellcheck disable=SC1091
  . "$EMSDK/emsdk_env.sh"
fi
