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
