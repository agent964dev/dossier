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

Apply migrations to the local development database:

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

Do not deploy the top-level Wrangler environment unless the production runbook has explicitly assigned that step.

## Bootstrap a fresh development deployment

The setup endpoint seeds the configured workspace, admin/domain allowlist, bootstrap service account, and bootstrap API key. It is insert-only and safe to rerun.

Set the two development secrets, deploy the endpoint, then run the setup wrapper:

```sh
cd apps/web
openssl rand -base64 48 | tr -d '\n' | bunx wrangler secret put SESSION_SECRET --env dev
openssl rand -base64 48 | tr -d '\n' > ../../.dev-bootstrap-key.local
chmod 600 ../../.dev-bootstrap-key.local
cat ../../.dev-bootstrap-key.local | bunx wrangler secret put BOOTSTRAP_API_KEY --env dev
CLOUDFLARE_ENV=dev bunx vite build
bunx wrangler deploy --env dev
scripts/setup.sh --env dev --key-file ../../.dev-bootstrap-key.local
```

Expected setup JSON includes:

```json
{
  "ok": true,
  "workspaceId": "workspace_agent964",
  "workspaceSlug": "agent964",
  "bootstrapAccountId": "acct_bootstrap",
  "bootstrapApiKeyId": "key_bootstrap"
}
```

The development origin is <https://dossier-dev.tech964.workers.dev>.

## Request routing

`src/worker.ts` routes `/api/*` to the merged Effect API, `/a/*` to workspace asset serving, `/d/*` to document/tree serving, `/auth/*` to authentication, and all remaining requests to TanStack Start. `POST /api/setup` is handled before normal API-key lookup and uses a constant-time comparison against the `BOOTSTRAP_API_KEY` Worker secret.

All API and serving responses use `Cache-Control: no-store` except immutable/pinned asset responses. Static Vite output uses the Wrangler `ASSETS` binding. That binding is inherited by `env.dev`; the Cloudflare Vite plugin injects the concrete client build directory into `dist/server/wrangler.json` during each build.

## CLI

Install the production CLI from npm:

```sh
npm install --global @agent964/dossier
dossier auth login
```

For development acceptance against the remote dev Worker, run from the repository root:

```sh
bun run --cwd packages/cli build
cat .dev-bootstrap-key.local | \
  node packages/cli/dist/index.js --api-url https://dossier-dev.tech964.workers.dev auth set
node packages/cli/dist/index.js --api-url https://dossier-dev.tech964.workers.dev whoami
```

## Production

The top-level Wrangler environment targets <https://dossier.agent964.com> with `workers_dev: false`, a custom-domain route, observability, production D1/R2 bindings, and Vite static assets. Follow [`../../docs/RUNBOOK.md`](../../docs/RUNBOOK.md) exactly for resource creation, the real D1 ID, secrets, migrations, deployment, setup, owner-only actions, and day-2 operations.
