# dossier

![CI](https://github.com/agent964dev/dossier/actions/workflows/ci.yml/badge.svg)

Dossier hosts trees of plain HTML.

- Agents push folders of plain HTML into trees. A page inherits its layouts,
  theme and components from the `_` files in the folders above it, so a tree
  shares one look and one set of components without a build step.
- Plain HTML forms keep each person's answers on the server, with drafts,
  closing and withdrawal. Pages read, watch and write that data live through a
  small page client.
- People open what is shared with them by signing in with Google. Shares give
  read, respond or write to a person, a team, the workspace or anyone.
- Every page has a version agents read: its companion file, or Markdown made
  from the page. `dossier read` prints it, and so does any link asked with an
  agent key.

Each tree's pages run on their own origin on a separate content domain, so
embeds from other sites play and page code never reaches the viewer's session.
Everything runs on Cloudflare: one Worker, D1, R2, a Durable Object per tree
and a Queue.

The owner's deployment is <https://dossier.agent964.com>.

## Install the CLI

The CLI needs Node.js 22.12 or newer.

```sh
npm i -g @agent964/dossier
dossier login
dossier push ./site agent964/acme
dossier read agent964/acme/plan.html
```

`dossier --agent-info` prints the guide agents read. See
[docs/CLI.md](docs/CLI.md) for every verb.

## Develop

```sh
bun install
bun run lint
bun run format:check
bun run typecheck
bun run test
bun run test:release
```

The repository uses Bun (the version is pinned in `package.json`), oxlint and
oxfmt. `bun run format` formats the repository. Each package runs its own
Vitest suite; `apps/web` runs its tests in the Workers runtime.

To run the Worker locally over HTTPS, with each tree on its own host, follow
[the dev environment](docs/RUNBOOK.md#6-the-dev-environment) in the runbook
once, then:

```sh
bun run --cwd apps/web dev:https
```

It serves `https://localhost:8787`, and each tree at
`https://<tree-id>.content.localhost:8787`.

## Workspace layout

- `apps/web`: the Worker. The edge, the core services, Dossier's own screens
  (TanStack Start), the tree hub Durable Object, the purge and webhook jobs,
  the D1 schema and migrations, and its tests.
- `packages/contracts`: the API contract, the error table, names and paths,
  and the messages between pages and the shell.
- `packages/html`: page analysis, the push rules, composition, form rules,
  Markdown for agents, search text and export planning. Pure code, no I/O.
- `packages/browser`: the shell, the page client, the base layout, the base
  components and the libraries pages get, built as static files.
- `packages/cli`: the `@agent964/dossier` command line.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the code is put together.
- [docs/CLI.md](docs/CLI.md): the command line.
- [docs/RUNBOOK.md](docs/RUNBOOK.md): running a deployment, setting up your
  own, releases and the dev environment.
- [GLOSSARY.md](GLOSSARY.md): the words Dossier uses.

## License

[MIT](LICENSE).
