# dossier

Dossier is a Bun workspace for publishing versioned HTML documents to a workspace-owned tree on Cloudflare Workers.

## Workspace layout

- `apps/web` — TanStack Start application and custom Worker entry, Effect HTTP API, Drizzle schema and D1 migrations, Cloudflare integration tests, and the agent964-styled web UI.
- `packages/policy` — runtime-neutral HTML and CSS upload policy shared by the Worker and CLI.
- `packages/contracts` — Effect schemas and the shared `HttpApi` contract.
- `packages/cli` — the `@agent964/dossier` command-line client.
- `docs` — the approved design plan, workflow notes, and source diagrams.
- `upstream` — read-only Postplan reference source.

## Development

Install the pinned workspace dependencies:

```sh
bun install
```

Run the repository checks from the workspace root:

```sh
bun run typecheck
bun run test
```

Start the web application and Worker locally:

```sh
bun run --cwd apps/web dev
```

See [`apps/web/README.md`](apps/web/README.md) for database and deployment commands.

## Phase 1 surfaces

The Worker entry keeps the runtime boundaries explicit:

- `/api/*` — the merged Effect `DossierApi` (`/api/healthz` and `/api/policy/check` remain public; the other phase-one routes require Bearer authentication).
- `/d/*` — byte-preserving document serving.
- `/auth/*` — shoo sign-in, callback, and sign-out.
- every other route — TanStack Start, including the dashboard, workspace, and CLI-key pages.

Build and run the phase-one CLI directly with Node 22.12 or newer:

```sh
bun run --cwd packages/cli build
node packages/cli/dist/index.js --api-url http://localhost:8787 health
```

The CLI supports `auth set`, `whoami`, `upload`, `list`, `fetch`, `delete`, `restore`, `disable`, and `enable`. See [`apps/web/README.md`](apps/web/README.md) for the development deployment, migration, secret, and bootstrap-seed procedure.
