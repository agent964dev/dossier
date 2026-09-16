#!/usr/bin/env bash
set -euo pipefail

# Vite selects the top-level production config at build time. Migrations use
# the source config's production database; deployment uses Vite's output.
unset CLOUDFLARE_ENV
cd apps/web
bunx --no-install wrangler d1 migrations apply dossier-production --remote --config wrangler.jsonc --no-x-provision
bunx --no-install wrangler deploy --config dist/server/wrangler.json --no-x-provision
