# dossier

![CI](https://github.com/agent964dev/dossier/actions/workflows/ci.yml/badge.svg)

Dossier publishes versioned HTML documents into workspace-owned trees on Cloudflare Workers. It keeps every version, supports inherited access boundaries and shares, serves reusable CSS/font assets, and provides both a dark-themed web dashboard and the `@agent964/dossier` CLI.

Provenance: Dossier descends from postplan 0.0.4 (MIT); its reference copy remains in repository history at commit [`5be3f93`](https://github.com/agent964dev/dossier/tree/5be3f93/upstream).

## Workspace layout

- `apps/web` — TanStack Start application, custom Worker entry, Effect HTTP API, Drizzle/D1 migrations, R2 document storage, integration tests, and the web UI.
- `packages/policy` — runtime-neutral HTML and CSS upload policy shared by the Worker and CLI.
- `packages/contracts` — Effect schemas and the shared `HttpApi` contract.
- `packages/cli` — the public `@agent964/dossier` command-line client.
- `packages/cli/skills/dossier` — packaged agent instructions for reading and publishing dossier documents.
- `docs` — architecture notes, CLI reference, production runbook.

## Install the CLI

The supported distribution is npm and requires Node 22.12 or newer (Bun also works):

```sh
npm install --global @agent964/dossier
dossier auth login
dossier whoami
```

After authentication, common commands include:

```sh
dossier upload report.html --kind report
dossier list --tree
dossier tree <document-id>
dossier diff <document-id>
dossier update
dossier assets push theme.css
dossier trash
```

## Develop

Install the pinned workspace dependencies:

```sh
bun install
```

Run repository checks:

```sh
bun run typecheck
bun run test
```

HTML/CSS policy fixtures live in `packages/policy/test/fixtures` and run through
`packages/policy/src/fixtures.test.ts`. Worker tests in `apps/web/test` cover
upload validation, serving headers, and access rules. Both run in CI through
`bun run test`. The retired `apps/web/browser` probes and their recorded results
have been removed; the suite does not require a global Playwright installation
or assert browser rendering and cookie behavior.

Dependabot checks all Bun workspace dependencies and GitHub Actions weekly on
Monday at 09:00 Baghdad time, with one group for each ecosystem. CI and release
workflows read the Bun runtime pin from `packageManager` in the root
`package.json`; update that field when upgrading Bun itself. The CLI, contracts,
and policy packages use Vitest 5 from the root; `apps/web` pins Vitest 4 because
the current Cloudflare test plugin requires it. Run tests through the workspace
scripts so each suite uses its own supported runner. Dependabot leaves Vitest
major upgrades for a coordinated Cloudflare plugin migration while continuing
minor and patch updates. Development uses Node 26 type declarations; CI still
runs the CLI on its supported Node 22 runtime.

### Lint and format

The repository uses oxc for linting and formatting:

```sh
bun run lint
bun run format
```

Lint fails on any warning. `.oxlintrc.json` allows in-place array sorting and
reversal because these operations use locally owned arrays or explicit copies,
and allows functions to stay near the service or test that uses them. CSS
side-effect imports are allowed for the app stylesheet. Shadowed bindings,
unstable React keys, and other suspicious code remain checked.

Start the web application and Worker locally:

```sh
bun run --cwd apps/web dev
```

Build and run the unpublished CLI from this checkout:

```sh
bun run --cwd packages/cli build
node packages/cli/dist/index.js --api-url http://localhost:8787 health
```

## Runtime surfaces

The Worker entry keeps the boundaries explicit:

- `/api/*` — the Effect API. Health and policy checks are public; document, asset, workspace, key, and diff operations require a Bearer API key.
- `POST /api/setup` — deployment-only bootstrap protected by `BOOTSTRAP_API_KEY`.
- `/d/*` — byte-preserving document serving and tree hubs.
- `/a/*` — versioned workspace CSS and WOFF2 assets.
- `/auth/*` — Shoo sign-in, callback, and sign-out.
- every other route — TanStack Start, including dashboard, trash, workspace, diff, and CLI-key pages.

## Production

Production runs at <https://dossier.agent964.com>. The top-level Wrangler environment is production; do not deploy it as part of ordinary development. The exact resource creation, secret, migration, deploy, bootstrap, owner handoff, rollback, and logging procedures are in [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

See [`apps/web/README.md`](apps/web/README.md) for local/development commands and Worker configuration details.
