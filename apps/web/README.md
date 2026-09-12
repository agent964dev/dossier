# @dossier/web

The web workspace combines TanStack Start, the Cloudflare Vite plugin, an Effect `HttpApi` handler, D1 through Drizzle, and R2 in one Worker.

## Develop

From the repository root:

```sh
bun install
bun run --cwd apps/web dev
```

The development server listens on `http://localhost:8787`. Useful smoke checks:

```sh
curl http://localhost:8787/api/healthz
curl -H 'content-type: text/html' --data-binary '<!doctype html><title>Policy check</title>' http://localhost:8787/api/policy/check
```

## Test and build

```sh
bun run --cwd apps/web typecheck
bun run --cwd apps/web test
bun run --cwd apps/web build
```

Run all workspace checks from the repository root with:

```sh
bun run typecheck
bun run test
```

## D1 migrations

Generate a migration after changing `src/db/schema.ts`:

```sh
bun run --cwd apps/web db:generate
```

Apply migrations to the local dev database:

```sh
cd apps/web
bunx wrangler d1 migrations apply dossier-development --local --env dev
```

Apply migrations to the remote development database:

```sh
cd apps/web
bunx wrangler d1 migrations apply dossier-development --remote --env dev
```

## Deploy development

Only the `dev` environment deploys to the development D1 database and R2 bucket:

```sh
bun run --cwd apps/web deploy:dev
```

Equivalent explicit commands:

```sh
cd apps/web
CLOUDFLARE_ENV=dev bunx vite build
bunx wrangler deploy --env dev
```

Do not deploy the top-level Wrangler environment unless a production deployment is explicitly authorised.

## Request routing

`src/worker.ts` routes `/api/*` to the merged Effect API, `/d/*` to document serving, `/auth/*` to the web authentication handler, and all remaining requests to TanStack Start. Phase-one API and serving responses use `Cache-Control: no-store`.

## Bootstrap a fresh development deployment

Run this only against `env.dev`. First apply migrations and inspect the development Worker's secret names:

```sh
cd apps/web
bunx wrangler d1 migrations apply dossier-development --remote --env dev
bunx wrangler secret list --env dev
```

If either secret is absent, create it. The bootstrap key is kept at the repository root in a gitignored, mode-0600 file so the CLI acceptance flow can use the same value:

```sh
openssl rand -base64 32 | bunx wrangler secret put SESSION_SECRET --env dev
openssl rand -base64 32 > ../../.dev-bootstrap-key.local
chmod 600 ../../.dev-bootstrap-key.local
cat ../../.dev-bootstrap-key.local | bunx wrangler secret put BOOTSTRAP_API_KEY --env dev
```

Seed the configured workspace, admin allowlist, domain allowlist, bootstrap service account, and hashed bootstrap API key with remote D1 SQL. This is insert-only and safe to rerun to finish an interrupted fresh seed; do not use it to rotate an existing bootstrap key.

```sh
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BOOTSTRAP_HASH="$(tr -d '\r\n' < ../../.dev-bootstrap-key.local | shasum -a 256 | awk '{print $1}')"
SQL="$(cat <<SQL
INSERT INTO accounts (id,name,kind,deployment_admin,disabled_at,created_at,updated_at)
VALUES ('acct_bootstrap','Bootstrap service','service',1,NULL,'$NOW','$NOW')
ON CONFLICT(id) DO NOTHING;
INSERT INTO workspaces (id,slug,kind,email_domain,name,created_at,updated_at)
VALUES ('workspace_agent964','agent964','team','agent964.com','agent964','$NOW','$NOW')
ON CONFLICT(id) DO NOTHING;
INSERT INTO allowlist (id,kind,value,workspace_id,role,created_by,created_at,last_used_at)
VALUES ('allow_agent964_admin','email','malhashemi@agent964.com','workspace_agent964','admin','acct_bootstrap','$NOW',NULL)
ON CONFLICT(value) DO NOTHING;
INSERT INTO allowlist (id,kind,value,workspace_id,role,created_by,created_at,last_used_at)
VALUES ('allow_agent964_domain','domain','agent964.com','workspace_agent964','member','acct_bootstrap','$NOW',NULL)
ON CONFLICT(value) DO NOTHING;
INSERT INTO api_keys (id,account_id,workspace_id,name,key_hash,created_at,last_used_at,revoked_at)
VALUES ('key_bootstrap','acct_bootstrap','workspace_agent964','Bootstrap','$BOOTSTRAP_HASH','$NOW',NULL,NULL)
ON CONFLICT(id) DO NOTHING;
SQL
)"
bunx wrangler d1 execute dossier-development --remote --env dev --command "$SQL"
```

Deploy only the development environment:

```sh
bun run deploy:dev
```

The current development origin is `https://dossier-dev.tech964.workers.dev`. A quick authenticated check after building the CLI is:

```sh
bun run --cwd ../../packages/cli build
cat ../../.dev-bootstrap-key.local | \
  node ../../packages/cli/dist/index.js --api-url https://dossier-dev.tech964.workers.dev auth set
node ../../packages/cli/dist/index.js --api-url https://dossier-dev.tech964.workers.dev whoami
```
