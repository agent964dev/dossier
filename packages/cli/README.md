# Dossier CLI

Publish, read, compare, and manage versioned HTML documents from your terminal.
Dossier organizes documents into workspace-owned trees, preserves published
versions, and supports shared CSS and font assets.

## Install

Requires **Node.js 22.12 or newer**. Bun is also supported.

```sh
npm install --global @agent964/dossier
dossier --help
```

## Sign in

```sh
dossier auth login
dossier whoami
```

`auth login` opens the Dossier sign-in page in your browser, then prompts you to
paste an API key. By default, the CLI connects to
[dossier.agent964.com](https://dossier.agent964.com).

For another deployment, supply its origin when signing in:

```sh
dossier --api-url https://dossier.example auth login
```

For scripts, set `DOSSIER_API_KEY` in the environment or pipe a key into
`dossier auth set`. Set `DOSSIER_API_URL` to choose another deployment.
Credentials are stored under `~/.dossier` by default; `DOSSIER_HOME` overrides
that directory.

## Publish and read documents

Create a complete HTML file, then upload it:

```sh
dossier upload report.html --kind report
dossier list --tree
```

Uploading the same file path again updates its mapped document with a new
version. Use `--new` to publish it as a separate document. The CLI validates
HTML and CSS before uploading; the deployment's policy is authoritative.

Use the document ID or URL returned by the upload in these commands:

```text
dossier fetch <id-or-url> -o saved-report.html
dossier tree <id-or-url>
dossier diff <id-or-url>
dossier diff <id-or-url> --from 1 --to 2 --text
```

`diff` compares the previous and latest versions by default. `--text` compares
visible text instead of HTML source. A reference such as `7k2m9x1qz3ab@2` pins
a particular version.

## Share assets and organize documents

```sh
dossier assets push theme.css
dossier assets push font.woff2
dossier assets list
dossier trash
```

```text
dossier move <id> --parent <parent-id>
dossier visibility <id> public
dossier share <id> --add reader@example.com
dossier delete <id>
dossier restore <id>
```

`delete` archives a document; a subtree requires `--force`. Archived documents
become eligible for permanent removal after the deployment's retention window,
normally 30 days. An operator must run the purge command to remove them
permanently.

## Use from scripts and agents

```sh
dossier upload report.html --kind report --json
dossier list --tree --json
dossier whoami --json
```

`--json` writes one JSON value to stdout; errors go to stderr. `--quiet` reduces
normal output, and uploads print only the resulting URL.

The package includes an agent skill at `skills/dossier/SKILL.md`. See the
[packaged skill instructions](https://github.com/agent964dev/dossier/blob/main/packages/cli/skills/dossier/SKILL.md)
for document policy and publishing guidance.

## Update

```sh
dossier update --check
dossier update
```

For a global npm installation, you can also run:

```sh
npm install --global @agent964/dossier@latest
```

## Documentation

- [Complete CLI reference](https://github.com/agent964dev/dossier/blob/main/docs/CLI.md)
- [Repository and development guide](https://github.com/agent964dev/dossier)
- [Deployment runbook](https://github.com/agent964dev/dossier/blob/main/docs/RUNBOOK.md)
- [Report an issue](https://github.com/agent964dev/dossier/issues)

## License

[MIT](https://github.com/agent964dev/dossier/blob/main/LICENSE).
