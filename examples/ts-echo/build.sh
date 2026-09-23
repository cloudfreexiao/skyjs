#!/bin/sh
# examples/ts-echo/build.sh -- strip TS types to plain JS for the snjs source
# loader. esbuild is a build-time tool only (fetched via npx on demand); the
# SkyJS runtime itself stays zero-dependency. ts-echo.js is generated and
# reproducible from ts-echo.ts; do not edit it by hand.
cd "$(dirname "$0")" || exit 1
exec npx --yes esbuild@0.28.2 ts-echo.ts \
    --bundle --format=iife --platform=neutral --target=es2022 \
    --outfile=ts-echo.js
