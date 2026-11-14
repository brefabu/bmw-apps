#!/bin/sh
# update-kit.sh - bring kit/ in from cauliflowermossgrape/idrive7-apps (MIT; kit/renderd and kit/emu GPL-3.0).
#
#   tools/update-kit.sh                 the commit pinned in kit/SOURCE.json (or the default below)
#   tools/update-kit.sh <commit|branch> another one, e.g. main, then review the diff and run the tests
#
# kit/ stays an unchanged copy. Our only changes to it are listed in kit/PATCHES.md and live in
# patches/kit/ (same paths as in kit/): they are copied over the fresh kit after every update.
set -eu

REPO=https://github.com/cauliflowermossgrape/idrive7-apps
DEFAULT=8d860de5818a2da11d3a3750aab36866cecf6bde
ROOT=$(cd "$(dirname "$0")/.." && pwd)
REF=${1:-}
if [ -z "$REF" ] && [ -f "$ROOT/kit/SOURCE.json" ]; then
    REF=$(sed -n 's/.*"commit": *"\([0-9a-f]*\)".*/\1/p' "$ROOT/kit/SOURCE.json")
fi
REF=${REF:-$DEFAULT}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "fetching $REPO @ $REF"
git -c advice.detachedHead=false clone -q --filter=blob:none --no-checkout "$REPO" "$TMP/src"
git -C "$TMP/src" checkout -q "$REF"
COMMIT=$(git -C "$TMP/src" rev-parse HEAD)
DATE=$(git -C "$TMP/src" log -1 --format=%cI)

rm -rf "$ROOT/kit"
cp -R "$TMP/src/kit" "$ROOT/kit"
cp "$TMP/src/LICENSE" "$ROOT/kit/LICENSE.idrive7-apps"
if [ -d "$ROOT/patches/kit" ]; then
    cp -R "$ROOT/patches/kit/." "$ROOT/kit/"
    echo "applied patches/kit (see kit/PATCHES.md)"
fi
cat > "$ROOT/kit/SOURCE.json" <<EOF
{
  "repository": "$REPO",
  "commit": "$COMMIT",
  "committed": "$DATE",
  "path": "kit",
  "license": "MIT (LICENSE.idrive7-apps); kit/renderd and kit/emu GPL-3.0-or-later (their own LICENSE files)",
  "note": "Unchanged copy. Our changes: kit/PATCHES.md and patches/kit/. Update with tools/update-kit.sh."
}
EOF
if [ ! -f "$ROOT/kit/PATCHES.md" ]; then
    printf '# Changes to the vendored kit\n\nNone yet. Every change made here goes into patches/kit/ (same path as in kit/) and gets a line below.\n' > "$ROOT/kit/PATCHES.md"
fi
echo "kit/ = idrive7-apps $COMMIT ($DATE)"
echo "next: node tests/test_seats_backend.js && node tests/smoke_pages.js && python3 kit/tools/build.py bre_hub"
