# Dossier CLI

`@agent964/dossier` publishes, reads, compares, and manages documents on a Dossier deployment. The `dossier` executable is ESM and supports Node.js 22.12 or newer and Bun.

## Install

```sh
npm install --global @agent964/dossier
dossier --help
```

## Global flags

The Dossier origin and output flags work before or after a subcommand, including nested subcommands.

| Flag | Meaning |
|---|---|
| `--api-url <url>` | Use this Dossier origin. HTTPS is required except for loopback development URLs. |
| `--json` | Print exactly one JSON value on stdout. Errors still print as `dossier: <message>` on stderr. |
| `-q`, `--quiet` | Suppress normal output. `upload` and `assets push` print only the resulting URL. |
| `-h`, `--help` | Show help for the selected command. |
| `--version` | Show the CLI version. |
| `--completions sh|bash|fish|zsh` | Generate a shell completion script. |
| `--log-level all|trace|debug|info|warning|error|fatal|none` | Set Effect CLI logging verbosity. |
| `--wizard` | Start Effect CLI's interactive command wizard. |

Examples:

```sh
dossier --json whoami
dossier whoami --json
dossier assets --api-url https://dossier.example list
```

### Configuration precedence

The API origin is selected in this order:

1. `--api-url`
2. `DOSSIER_API_URL`
3. `$DOSSIER_HOME/config.json` → `apiUrl`
4. `https://dossier.agent964.com`

The API key is selected in this order:

1. `DOSSIER_API_KEY`
2. `$DOSSIER_HOME/credentials.json`, keyed by API origin

`DOSSIER_HOME` defaults to `~/.dossier`. The directory is mode `0700`; credentials, config, document mappings, temporary files, and lock files are written atomically with private permissions. Credentials are never sent across origins or redirects.

## Document references

Every `<id>` argument accepts:

- A 12-character lowercase Dossier ID: `7k2m9x1qz3ab`
- A pinned ID: `7k2m9x1qz3ab@4`
- A canonical document URL on the configured origin: `https://dossier.agent964.com/d/7k2m9x1qz3ab`
- A pinned canonical URL: `https://dossier.agent964.com/d/7k2m9x1qz3ab/v/4`

A URL from another origin is a usage error. `fetch` uses a pinned version. `diff` treats a pinned version as `--to`. Commands that act on the document itself accept pinned references and use their document ID.

## Authentication

### `dossier auth login`

Opens `<configured-origin>/cli/auth` in the default browser, prompts for a pasted key, verifies it, and stores it for that origin. It requires an interactive terminal and does not support `--json` or `--quiet`.

```sh
dossier auth login
dossier --api-url https://dossier.example auth login
```

### `dossier auth set [key]`

Stores a key without opening a browser. When `[key]` is omitted, stdin is read; this is preferred in scripts and avoids shell history.

```sh
printf '%s\n' "$DOSSIER_KEY" | dossier auth set
dossier --api-url https://dossier.example auth set ds_example
```

When `--api-url` is supplied, that origin is also saved in `config.json`.

### `dossier auth logout`

Removes the stored key for the configured origin.

### `dossier whoami`

Prints the current account, workspace, role, and API-key identity.

## Documents

### `dossier upload <file>`

Validates and uploads one complete HTML document.

```text
dossier upload <file>
  [--parent <id|root>]
  [--kind <kind>]
  [--visibility public|team|private|inherit]
  [--share <email,email>]
  [--description <text>]
  [--new | --doc <id>]
```

The CLI records successful uploads by configured origin, account, and absolute file path. Uploading the same path again updates that document. Omitted metadata flags leave existing values unchanged.

- `--new` creates a distinct document and replaces the local path mapping.
- `--doc <id>` explicitly updates a document.
- `--parent root` creates at the root; another reference creates beneath that document.
- Re-upload cannot move a document. If a different parent is requested, use `dossier move`.
- `--visibility inherit` stores no explicit boundary.
- `--share` is a comma-separated initial share list.

Human output includes Created/Updated, URL, Raw, Hub, ID, Version, Parent, and Visibility. `--json` returns the document DTO plus `versionNumber`, `created`, and `warnings`.

### `dossier fetch <id-or-url>`

```text
dossier fetch <id-or-url> [--version <n>] [-o, --output <file>]
```

Writes the exact stored bytes to stdout or to a file. A version in the reference must agree with `--version`. With `--json` and no output file, content is returned as `contentBase64`.

```sh
dossier fetch 7k2m9x1qz3ab@4 -o /tmp/document.html
dossier fetch https://dossier.agent964.com/d/7k2m9x1qz3ab --version 2
```

### `dossier diff <id>`

```text
dossier diff <id> [--from <n>] [--to <n>] [--text]
```

Requests `GET /api/documents/:id/diff` and prints a standard unified diff. The default comparison is the previous version against the latest. `--text` compares visible normalized text rather than HTML source. A pinned reference supplies `--to`; an inconsistent explicit `--to` is a usage error.

File headers are `--- a/<id>@<from>` and `+++ b/<id>@<to>`. Additions and deletions are colored only when stdout is a TTY and `NO_COLOR` is unset. A successful comparison exits `0` even when changes exist. `--json` prints the server's complete diff response. If the server returns `413 diff_too_large`, fetch the two versions and compare them locally.

### `dossier list`

```text
dossier list [--all] [--tree] [--parent <id|root>] [--trash]
```

Lists the current account's documents. `--all` includes every readable document. `--tree` prints a nested readable forest. `--parent` focuses the list on one parent. `--trash` lists archived documents and cannot be combined with the other list filters; `dossier trash` is the batch-oriented human view.

### `dossier tree <id>`

Prints the readable breadcrumb, siblings, and children for one document. Unreadable structure is intentionally omitted.

### `dossier move <id> --parent <id|root>`

Moves a document and its subtree without changing authorship.

### `dossier visibility <id> <level>`

`<level>` is `public`, `team`, `private`, or `inherit`.

### `dossier share <id>`

```text
dossier share <id> [--add <email,email>] [--remove <email,email>]
```

At least one flag is required. The CLI uses the server's atomic delta endpoint and never performs a GET-then-PUT replacement.

### Archive and serving commands

```sh
dossier delete <id> [--force]
dossier trash
dossier restore <id> [--batch <batch-id>]
dossier disable <id>
dossier enable <id>
```

`delete` never prompts. A subtree requires `--force`; without it, the error reports descendant and author impact. `trash` groups archived documents by deletion batch. `restore` discovers the document's batch when `--batch` is omitted. `disable` and `enable` affect serving for one node.

## Shared assets

### `dossier assets push <file> [--slug <slug>]`

Uploads `.css` or `.woff2`. CSS is checked locally before authentication; the server policy remains authoritative. A slug must be at most 64 lowercase letters, digits, or hyphens and defaults to the filename stem. Human output includes both the latest and pinned version URLs.

### `dossier assets list`

Lists active assets and their latest and pinned URLs.

### `dossier assets delete <slug>`

Stops serving the latest URL. Pinned asset versions continue to serve.

## Workspace administration

Workspace commands require an admin key.

```sh
dossier workspace
dossier workspace members
dossier workspace allow <email|@domain> [--role admin|member]
dossier workspace disallow <email|@domain>
dossier workspace promote <email>
dossier workspace remove <email>
```

`workspace` prints members and the sign-in allowlist; `workspace members` prints only members. `allow` defaults to role `member`. Removing an allowlist entry prevents future sign-ins but does not remove an existing membership. `promote` and `remove` resolve the current member by verified email before calling the account-ID API.

## Deployment setup

`dossier setup` is for deployment operators, not routine client configuration. It calls the deployed Worker's protected `POST /api/setup` endpoint. Supply the bootstrap secret through `BOOTSTRAP_API_KEY`, `DOSSIER_API_KEY`, credentials for the configured origin, or stdin. The command does not create resources, apply migrations, or deploy the Worker.

The Worker reads its configured `SEED_WORKSPACE` and `SEED_ADMIN_EMAIL`, then idempotently creates the initial workspace, allowlist, bootstrap account, and bootstrap key record. Apply remote D1 migrations before calling it. The repository's `apps/web/scripts/setup.sh` wrapper performs both steps without exposing the key in process arguments.

```sh
cat .prod-bootstrap-key.local | \
  dossier --api-url https://dossier.agent964.com setup --json
```

## Diagnostics

`dossier health` is a hidden compatibility command that calls `/api/healthz`; it is useful for deployment smoke checks.

## Exit codes and error output

| Code | Meaning |
|---:|---|
| `0` | Success. A diff with changes is still success. |
| `1` | Operational failure, policy rejection, server error, conflict, or not found. |
| `2` | Invalid command usage, option, reference, or configured URL. |
| `4` | Authentication is missing or rejected. |

Errors are written to stderr as:

```text
dossier: <message>
```

With `--json`, stdout still contains exactly one JSON value; scripts should use the exit code as the primary success signal.
