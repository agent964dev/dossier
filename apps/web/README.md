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
