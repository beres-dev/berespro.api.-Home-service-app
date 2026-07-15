#!/usr/bin/env bash
# Berespro — one-shot production deploy to Cloudflare.
# Run once first:  wrangler login
# Then:            bash deploy.sh
set -e
echo "=== Berespro production deploy ==="

if ! command -v wrangler >/dev/null 2>&1; then
  echo "Installing wrangler (one time)..."; npm install -g wrangler
fi

echo ">> Creating D1 database 'berespro' (skips if it exists)..."
CREATE_OUT="$(wrangler d1 create berespro 2>&1 || true)"
echo "$CREATE_OUT"

DBID="$(echo "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
if [ -z "$DBID" ]; then
  DBID="$(wrangler d1 list --json 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
fi
if [ -n "$DBID" ]; then
  echo ">> Using database_id: $DBID"
  sed -i "s/PASTE_YOUR_D1_DATABASE_ID_HERE/$DBID/" wrangler.toml
else
  echo "!! Could not auto-detect database_id. Paste it into wrangler.toml manually, then re-run."; exit 1
fi

echo ">> Initialising schema (all tables)..."
wrangler d1 execute berespro --remote --file=./schema.sql

if [ -f jwt_secret.txt ]; then
  echo ">> Setting JWT_SECRET..."; wrangler secret put JWT_SECRET < jwt_secret.txt
fi

echo ">> Deploying Worker..."
wrangler deploy

echo ""
echo "=== DONE ==="
echo "Your API is live at the workers.dev URL shown above. Copy it into the app as API Base URL."
