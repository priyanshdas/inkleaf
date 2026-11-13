#!/bin/sh
# Builds inkleaf-thumbs.dll with MinGW-w64 (on Linux, or MSYS2 on Windows).
# The Windows release workflow builds it the same way.
set -e
cd "$(dirname "$0")"
CXX=${CXX:-x86_64-w64-mingw32-g++}
$CXX -O2 -std=c++17 -shared -static -static-libgcc -static-libstdc++ -fno-exceptions -fno-rtti \
  -Wall -Wextra -Wno-unused-parameter -s -Wl,--gc-sections \
  -o inkleaf-thumbs.dll inkleaf-thumbs.cpp inkleaf-thumbs.def \
  -lole32 -luuid -lshlwapi -lgdi32
