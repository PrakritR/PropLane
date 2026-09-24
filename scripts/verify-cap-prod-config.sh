#!/bin/sh
# Xcode Release build guard: refuse to build/archive when the synced Capacitor
# config points anywhere but the production origin. The server URL is baked
# into the binary at sync time — shipping a dev/LAN URL means a white screen
# for every user, and it can't be fixed server-side after submission.
# Fix: `npm run cap:prod`, then archive again.
set -eu

# Debug builds legitimately point at a LAN dev server (npm run cap:dev).
if [ "${CONFIGURATION:-Release}" != "Release" ]; then
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_JSON="$REPO_ROOT/ios/App/App/capacitor.config.json"
PROD_ORIGIN="https://proplane.ai"

fail() {
  echo "error: [cap-prod-guard] $1" >&2
  echo "error: [cap-prod-guard] Run 'npm run cap:prod' in the repo root, then build again." >&2
  exit 1
}

[ -f "$CONFIG_JSON" ] || fail "missing $CONFIG_JSON — run 'npm run cap:prod' to sync it."

if [ -f "$REPO_ROOT/.cap-dev-server" ]; then
  fail ".cap-dev-server marker exists — the next cap sync would bake a dev URL into the app."
fi

URL="$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG_JSON" | head -1)"
case "$URL" in
  "$PROD_ORIGIN" | "$PROD_ORIGIN"/*) ;;
  *) fail "server.url is '$URL' — a Release build must load $PROD_ORIGIN." ;;
esac

if grep -q '"cleartext"[[:space:]]*:[[:space:]]*true' "$CONFIG_JSON"; then
  fail "server.cleartext is true — only http:// dev servers need that."
fi

echo "[cap-prod-guard] OK: Release build points at $URL"
