#!/usr/bin/env bash
set -euo pipefail

# Vite selects the top-level production config at build time. Migrations use
# the source config's production database; deployment uses Vite's output.
unset CLOUDFLARE_ENV
cd apps/web
bunx --no-install wrangler d1 migrations apply dossier-next-production --remote --config wrangler.jsonc --no-x-provision
# Pages opened before this deploy keep loading their base-layer version from R2.
bun scripts/copy-base.ts --bucket dossier-next-production --env production
bunx --no-install wrangler deploy --config dist/server/wrangler.json --no-x-provision
