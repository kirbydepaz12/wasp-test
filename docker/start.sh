#!/bin/sh
set -eu
# Generate a persistent per-installation scanner secret when none was supplied.
# Stored inside the local state volume; never modifies Cloudflare production.
if [ -z "${SCANNER_SECRET:-}" ]; then
  SECRET_FILE=/app/.wrangler/state/.scanner-secret
  mkdir -p /app/.wrangler/state
  if [ ! -s "$SECRET_FILE" ]; then
    node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
  fi
  SCANNER_SECRET=$(cat "$SECRET_FILE")
fi
export SCANNER_SECRET
# Supply optional Spotify and metadata bindings through a private dev-vars file.
# Do not pass API credentials as command-line arguments or bake them into images.
node /app/docker/write-dev-vars.mjs
# Keep the JSON origin map intact. A shell parameter expansion containing a
# literal { default appends an extra } when the variable is already set.
PEER_ORIGIN_ALIASES="${PEER_RELAY_ALIASES:-}"
if [ -z "$PEER_ORIGIN_ALIASES" ]; then PEER_ORIGIN_ALIASES='{}'; fi
node /app/docker/gateway.mjs &
GATEWAY_PID=$!
npx wrangler dev -c wrangler.local.jsonc --ip 127.0.0.1 --port 8787 --persist-to /app/.wrangler/state --local --var "WASP_RUNTIME:docker" --var "SCANNER_SECRET:$SCANNER_SECRET" --var "PEER_ORIGIN_ALIASES:$PEER_ORIGIN_ALIASES" --var "PEER_PLAY_SYNC:${PEER_PLAY_SYNC:-1}" --var "WASP_BUILD_SHA:${WASP_BUILD_SHA:-}" &
WORKER_PID=$!
node /app/docker/cron-poller.mjs &
CRON_PID=$!
trap 'kill "$GATEWAY_PID" "$WORKER_PID" "$CRON_PID" 2>/dev/null || true' EXIT INT TERM
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
