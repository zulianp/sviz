#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cmake -S "$ROOT" -B "$ROOT/build" -DCMAKE_BUILD_TYPE="${CMAKE_BUILD_TYPE:-Release}"
