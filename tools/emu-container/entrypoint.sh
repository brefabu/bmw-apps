#!/bin/sh
# Starts the emulator for one app (default bre_hub).
#
# The repository is mounted read-only at /work. A Windows folder mounted into Docker Desktop (9p/drvfs) sends
# no file-change events, so emu.js would never see a save: the emulator runs from a copy in /app (the
# container's own filesystem) and rsync brings changes over once a second. emu.js then rebuilds on a save as
# usual; dist/ and preview/ stay in the container.
#
# emu.js serves only on 127.0.0.1:8077 and checks the Host header, so socat forwards the container's port
# 8078 to it; compose publishes 8078 as 127.0.0.1:8077 on the host, and the browser's Host stays localhost:8077.
set -e
app="${1:-bre_hub}"

rsync -a --exclude .git --exclude dist --exclude preview --exclude out --exclude reference \
    --exclude node_modules --exclude __pycache__ /work/ /app/
if [ ! -f /app/oap-sdk/index.js ]; then
    echo "bre-emu: no oap-sdk/ - building with --preview-only (fine for the emulator, nothing installable)"
fi

# only what emu.js watches (apps/, kit/runtime/); rsync rewrites only the files that changed. --inplace:
# Node watches each file by its inode, and rsync's usual temp file + rename would give a changed file a new
# inode, so only its first change would be seen
(
    while :; do
        rsync -a --inplace --delete --exclude __pycache__ /work/apps/ /app/apps/
        rsync -a --inplace --delete /work/kit/runtime/ /app/kit/runtime/
        sleep 1
    done
) &

socat TCP-LISTEN:8078,fork,reuseaddr TCP:127.0.0.1:8077 &
exec node kit/tools/emu.js "$app" --port 8077
