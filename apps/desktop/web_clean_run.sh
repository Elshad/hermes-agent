#!/bin/bash

cd ~/.hermes-2/hermes-agent

DIST_DIR="./apps/desktop/dist"
if [ -d "$DIST_DIR" ]; then
    find "$DIST_DIR" -maxdepth 1 -type f -name '*js' -delete
    echo "Deleted JS files from /dist"
fi

ASSETS_DIR="./apps/desktop/dist/assets"
if [ -d "$ASSETS_DIR" ]; then
    find "$ASSETS_DIR" -maxdepth 1 -type f -name '*js' -delete
    echo "Deleted JS files from /dist/assets"
fi

HERMES_HOME=~/.hermes-2 taskset --cpu-list 0,1 ./venv/bin/hermes desktop-web --source --force-build --build-only  --host 0.0.0.0 --port 13043
HERMES_HOME=~/.hermes-2 ./venv/bin/hermes desktop-web --skip-build --host 0.0.0.0 --port 13043