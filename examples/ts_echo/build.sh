#!/bin/sh
# examples/ts_echo/build.sh -- strip TS types to plain JS for the snjs source
# loader. esbuild is a build-time tool only (fetched via npx on demand); the
# SkyJS runtime itself stays zero-dependency. ts_echo.js is generated and
# reproducible from ts_echo.ts; do not edit it by hand.
cd "$(dirname "$0")" || exit 1
exec npx --yes esbuild@0.28.2 ts_echo.ts \
    --bundle --format=iife --platform=neutral --target=es2022 \
    --outfile=ts_echo.js
