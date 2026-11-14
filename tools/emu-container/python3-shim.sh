#!/bin/sh
# Installed as /usr/local/bin/python3 in the emulator container (ahead of /usr/bin/python3 on PATH).
# emu.js builds with "python3 <root>/kit/tools/build.py <id>", which stops without BMW's SDK (oap-sdk/).
# Without the SDK this adds --preview-only: the emulator runs dist/<id> on a stubbed head unit
# (kit/tools/hu-stub.js) and never loads the SDK. With oap-sdk/ present the build runs unchanged.
case "$1" in
    */kit/tools/build.py)
        root="${1%/kit/tools/build.py}"
        if [ ! -f "$root/oap-sdk/index.js" ] || [ ! -f "$root/oap-sdk/package.json" ]; then
            script="$1"
            shift
            exec /usr/bin/python3 "$script" --preview-only "$@"
        fi
        ;;
esac
exec /usr/bin/python3 "$@"
