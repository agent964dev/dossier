# Dossier CLI

`@agent964/dossier` publishes, reads, compares, and manages documents on a Dossier deployment. The `dossier` executable is ESM and supports Node.js 22.12 or newer and Bun.

## Install

```sh
npm install --global @agent964/dossier
dossier --help
```

## Global flags

The Dossier origin and output flags work before or after a subcommand, including nested subcommands.

| Flag                    | Meaning                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `--api-url <url>`       | Use this Dossier origin. The CLI requires HTTPS except for loopback development URLs.         |
| `--json`                | Print exactly one JSON value on stdout. Errors still print as `dossier: <message>` on stderr. |
| `-q`, `--quiet`         | Suppress normal output. `upload` and `assets push` print only the resulting URL.              |
| `-h`, `--help`          | Show help for the selected command.                                                           |
| `--version`             | Show the version from the installed package.json.                                             |
| `--completions <shell>` | Generate a shell completion script for sh, bash, fish, or zsh.                                |
| `--log-level <level>`   | Set Effect CLI logging verbosity to all, trace, debug, info, warning, error, fatal, or none.  |
| `--wizard`              | Start Effect CLI's interactive command wizard.                                                |

These examples place global flags before and after subcommands.

```sh
dossier --json whoami
dossier whoami --json
dossier assets --api-url https://dossier.example list
```

### Configuration precedence

The CLI selects the API origin in this order.

1. Use `--api-url` when present.
2. Otherwise, use `DOSSIER_API_URL` when present.
3. Otherwise, read `apiUrl` from `$DOSSIER_HOME/config.json`.
4. Otherwise, use `https://dossier.agent964.com`.

The CLI selects the API key in this order.

1. Use `DOSSIER_API_KEY` when present.
2. Otherwise, read the key for the API origin from `$DOSSIER_HOME/credentials.json`.

`DOSSIER_HOME` defaults to `~/.dossier`. The CLI creates the directory with mode `0700` and writes credentials, config, document mappings, temporary files, and lock files atomically with private permissions. The CLI never sends credentials across origins or redirects.

## Document references

Every `<id>` argument accepts these forms.

- Use a 12-character lowercase Dossier ID, such as `7k2m9x1qz3ab`.
- Pin a version with an ID such as `7k2m9x1qz3ab@4`.
- Use a canonical document URL on the configured origin, such as `https://dossier.agent964.com/d/7k2m9x1qz3ab`.
- Pin a version with a canonical URL such as `https://dossier.agent964.com/d/7k2m9x1qz3ab/v/4`.

A URL from another origin is a usage error. `fetch` uses a pinned version. `diff` treats a pinned version as `--to`. Commands that act on the document itself accept pinned references and use their document ID.

## Authentication

### `dossier auth login`

`auth login` opens `<configured-origin>/cli/auth` in the default browser, prompts for a pasted key, verifies it, and stores it for that origin. It requires an interactive terminal and does not support `--json` or `--quiet`.

```sh
dossier auth login
dossier --api-url https://dossier.example auth login
```

### `dossier auth set [key]`

`auth set` stores a key without opening a browser. When you omit `[key]`, the command reads the key from stdin. Scripts should pipe the key this way because it keeps the key out of shell history.

```sh
printf '%s\n' "$DOSSIER_KEY" | dossier auth set
dossier --api-url https://dossier.example auth set ds_example
```

When you supply `--api-url`, the CLI also saves that origin in `config.json`.

### `dossier auth logout`

`auth logout` removes the stored key for the configured origin.

### `dossier whoami`

`whoami` prints the current account, workspace, role, and API-key identity.

## Documents

### `dossier upload <file>`

`upload` validates and uploads one complete HTML document.

```text
dossier upload <file>
  [--parent <id|root>]
  [--kind <kind>]
  [--visibility public|team|private|inherit]
  [--share <email,email>]
  [--description <text>]
  [--new | --doc <id>]
  [--stateful]
  [--accept-state-changes]
```

The CLI records successful uploads by configured origin, account, and absolute file path. Uploading the same path again updates that document. Omitted metadata flags leave existing values unchanged.

- `--new` creates a distinct document and replaces the local path mapping.
- `--doc <id>` explicitly updates a document.
- `--parent root` creates at the root. Another reference creates beneath that document.
- Re-upload cannot move a document. To choose a different parent, use `dossier move`.
- `--visibility inherit` stores no explicit boundary.
- `--share` is a comma-separated initial share list.
- `--description` sets the document description.
- `--stateful` enables one shared set of saved values for controls marked with `data-state`. Dossier keeps saved values enabled on later uploads without the flag.
- `--accept-state-changes` confirms a change that would retype or orphan a saved field. Dossier resets retyped values to their new defaults and keeps values for removed fields.

Human output includes Created/Updated, URL, Raw, Hub, ID, Version, Parent, and Visibility. A saved-values document also prints `State: enabled, one shared set of saved values` and `Last saved: <time|never>`. An accepted retype prints a `Reset saved values:` line followed by one indented `- <name>` line per reset field. `--json` returns the document DTO plus `versionNumber`, `created`, `warnings`, and `resetStateFields`. The document DTO includes `stateful`, `stateRevision`, and `stateUpdatedAt`. Quiet output remains the document URL alone.

A normal re-upload keeps saved values, grants, and the active edit link. `--new` starts a separate document with authored defaults and no copied grant or link. A field keeps its saved value when its `data-state` name and type stay the same. A removed field keeps its saved value. Adding that name back with the same type restores the value.

Before a `--stateful` upload, the CLI reads `/api/healthz` and requires `features` to contain `state`. It performs the same check for a locally mapped saved-values document, every `dossier state` operation, and `dossier share --edit-state`. A target without the feature fails before the CLI sends a saved-values request and prints this line.

```text
dossier: This Dossier deployment does not support saved values. Update the deployment.
```

### `dossier fetch <id-or-url>`

```text
dossier fetch <id-or-url> [--version <n>] [-o, --output <file>]
```

`fetch` writes the exact stored bytes to stdout or to a file. A version in the reference must agree with `--version`. With `--json` and no output file, the CLI returns content as `contentBase64`.

```sh
dossier fetch 7k2m9x1qz3ab@4 -o /tmp/document.html
dossier fetch https://dossier.agent964.com/d/7k2m9x1qz3ab --version 2
```

### `dossier diff <id>`

```text
dossier diff <id> [--from <n>] [--to <n>] [--text]
```

`diff` requests `GET /api/documents/:id/diff` and prints a standard unified diff. The default comparison is the previous version against the latest. `--text` compares visible normalized text rather than HTML source. A pinned reference supplies `--to`. An explicit `--to` that disagrees with the pin is a usage error.

File headers are `--- a/<id>@<from>` and `+++ b/<id>@<to>`. The CLI colors additions and deletions only when stdout is a TTY and `NO_COLOR` is unset. A successful comparison exits `0` even when changes exist. `--json` prints the server's complete diff response. If the server returns `413 diff_too_large`, fetch the two versions and compare them locally.

### `dossier list`

```text
dossier list [--all] [--tree] [--parent <id|root>] [--trash]
```

`list` lists the current account's documents. `--all` includes every readable document. `--tree` prints a nested readable forest. `--parent` focuses the list on one parent. `--trash` lists archived documents and rejects the other list filters. `dossier trash` is the batch-oriented human view.

### `dossier tree <id>`

`tree` prints the readable breadcrumb, siblings, and children for one document. It omits unreadable structure.

### `dossier move <id> --parent <id|root>`

`move` moves a document and its subtree without changing authorship.

### `dossier visibility <id> <level>`

`<level>` is `public`, `team`, `private`, or `inherit`.

### `dossier share <id>`

```text
dossier share <id>
  [--add <email,email>]
  [--remove <email,email>]
  [--edit-state]
```

Without `--add` or `--remove`, the command reads the current view shares and saved-values grants. `--add` grants view access. `--add --edit-state` grants view and save access to the named verified email on this document. `--remove --edit-state` removes save access but keeps view access. On a deployment with saved values, `--remove` removes both the view share and any saved-values grant for that email.

`share`, `share --add`, and `share --remove` keep working on a deployment that predates saved values. Such a deployment omits `grants` from the response, and the CLI treats the missing field as an empty list and prints view-only permissions. On that deployment a plain `--remove` sends only the view-share removal, because its API rejects the grant fields. A current deployment that has saved values switched off still receives the grant removal.

A saved-values grant does not grant permission to publish, replace HTML, change sharing, or reach another document. The CLI uses the server's atomic delta endpoint and never performs a GET-then-PUT replacement.

Human output prints Configured, Effective, Permissions, and Access source. Each permission line says `view` or `view and save`. `--json` returns `configured`, `effective`, `accessSource`, and `grants`, where each grant contains `email` and `canSave`. Quiet mode prints nothing.

## Saved values

Dossier stores one shared set of values for each saved-values document. A collaborator changes values in the first-party wrapper and chooses Save. Other visitors see the latest saved values after they reload the document. Dossier does not create a submission per visitor, save arbitrary page changes automatically, or provide live co-editing.

The CLI uses its normal Bearer API key for every command in this section. Anonymous edit links work only in the browser.

### `dossier state get <id>`

```sh
dossier state get <id>
dossier state get <id> --json
dossier state get <id> --quiet
```

Anyone who can read the document can read its saved values. Human output prints the value object, the shared revision, and the last saved time.

```text
Values:
{
  "objective": "Launch the new website",
  "approved": true
}
Revision: 7
Last saved: 2026-09-14T07:42:00Z
```

Before the first save, revision is `0`, the last saved time is `never`, and authored defaults fill the value object. False, zero, null, and empty values remain present. Saved values for fields removed from the current HTML also remain present.

`--json` prints one `StateResponse` value with `documentId`, `version`, `revision`, `updatedAt`, `data`, and `fields`. Each entry in `fields` contains `value`, `revision`, and `type`. Quiet mode prints nothing.

### `dossier state set <id>`

```text
dossier state set <id> --data <values.json> [--revision <n>]
```

The JSON file must contain one object that maps saved-value names to values. The command changes only the names present in that object. The caller must manage the document or hold a signed-in saved-values grant.

With `--revision`, the CLI sends that number as the baseline for every supplied field. Pass the revision from the earlier `state get` that informed the changes. Without `--revision`, the CLI reads the current state first and uses each field revision from that read. This read-first mode detects saves that race with the command itself. It does not protect work prepared from an earlier read. The CLI has no force-write mode.

Human output prints the new revision and last saved time. `--json` prints the complete saved `StateResponse`. Quiet mode prints the new revision as one line.

### `dossier state link`

A document manager can issue one active anonymous edit link for a saved-values document. Anyone who holds the complete link can read and save the document's values and can forward the link. The link does not grant permission to publish, change sharing, or use the CLI. Revocation stops link access without changing signed-in grants.

#### `dossier state link create <id>`

```sh
dossier state link create <id>
```

Create returns the active link when one already exists. Otherwise, it creates a link. Human output prints the warning and then the URL.

```text
Anyone with this link can read and change the saved values and can forward it.
https://dossier.example/d/abcdefghijkl/edit#<token>
```

`--json` returns `documentId`, `active: true`, and `editUrl`. Quiet mode prints only the URL.

#### `dossier state link get <id>`

```sh
dossier state link get <id>
```

Human output prints the active URL or `No active edit link`. `--json` returns `documentId`, `active`, and `editUrl`. An absent link has `active: false` and `editUrl: null`. Quiet mode prints the URL when a link exists and prints nothing when none exists.

#### `dossier state link revoke <id>`

```sh
dossier state link revoke <id>
```

Human output prints `Edit link revoked` or `No edit link to revoke`. `--json` returns `documentId` and `revoked`. Quiet mode prints nothing. A later create operation issues a link with a new generation.

### Archive and serving commands

```sh
dossier delete <id> [--force]
dossier trash
dossier restore <id> [--batch <batch-id>]
dossier disable <id>
dossier enable <id>
```

`delete` never prompts. A subtree requires `--force`. Without it, the error reports descendant and author impact. `trash` groups archived documents by deletion batch. `restore` discovers the document's batch when you omit `--batch`. `disable` and `enable` affect serving for one node.

## Maintenance

### `dossier update [--check]`

`update` checks the npm registry and updates a globally installed CLI with the package
manager that installed it. Supported global installs are npm, Bun, pnpm, and
Yarn classic. The command never downgrades a locally newer version.

```sh
dossier update --check
dossier update
dossier update --json
dossier update -q
```

`--check` reports availability without installing and exits `0` whether or not
an update exists. `--json` emits one result object on stdout and routes
installer output to stderr. Quiet mode prints nothing unless an update runs or
an error occurs. The command refuses automatic updates for npx, bunx, source checkouts,
unknown installations, and Windows. The error gives a manual command where
applicable.
Permission errors show the exact command to rerun with elevated rights and never
invoke `sudo` automatically.

`DOSSIER_UPDATE_REGISTRY_URL` overrides the npm registry origin. It exists only
for automated testing. Normal usage leaves it unset.

## Shared assets

### `dossier assets push <file> [--slug <slug>]`

`assets push` uploads `.css` or `.woff2`. The CLI checks CSS locally before authentication. The server policy remains authoritative. A slug must be at most 64 lowercase letters, digits, or hyphens and defaults to the filename stem. Human output includes both the latest and pinned version URLs.

### `dossier assets list`

`assets list` lists active assets and their latest and pinned URLs.

### `dossier assets delete <slug>`

`assets delete` stops serving the latest URL. Pinned asset versions continue to serve.

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

`workspace` prints members and the sign-in allowlist. `workspace members` prints only members. `allow` defaults to role `member`. Removing an allowlist entry prevents future sign-ins but does not remove an existing membership. `promote` and `remove` resolve the current member by verified email before calling the account-ID API.

## Deployment setup

`dossier setup` is for deployment operators, not routine client configuration. It calls the deployed Worker's protected `POST /api/setup` endpoint. Supply the bootstrap secret through `BOOTSTRAP_API_KEY`, `DOSSIER_API_KEY`, credentials for the configured origin, or stdin. The command does not create resources, apply migrations, or deploy the Worker.

The Worker reads its configured `SEED_WORKSPACE` and `SEED_ADMIN_EMAIL`, then idempotently creates the initial workspace, allowlist, bootstrap account, and bootstrap key record. Apply remote D1 migrations before calling it. The repository's `apps/web/scripts/setup.sh` wrapper performs both steps without exposing the key in process arguments.

```sh
cat .prod-bootstrap-key.local | \
  dossier --api-url https://dossier.agent964.com setup --json
```

## Deployment administration

`dossier admin purge` is for deployment operators, not routine use. It calls the deployed Worker's protected `POST /api/admin/purge`, which reports the archived deletion batches past the retention window. Supply the bootstrap secret through `BOOTSTRAP_API_KEY`, `DOSSIER_API_KEY`, credentials for the configured origin, or stdin, just as with `dossier setup`.

```sh
dossier admin purge
dossier admin purge --retention-days 45
dossier admin purge --execute
dossier admin purge --json
```

Without `--execute` the command is a dry run and the server writes nothing. `--retention-days` overrides the server's window for one run. When batches exist, human output shows one row per batch followed by totals. When none exist, it prints only `No batch is past the retention window (cutoff <timestamp>).`. `--json` prints the server's report as one JSON value.

```text
Dry run: archived batches older than 2026-08-15T03:17:00.000Z
  BATCH           ROOT         DOCS  VERSIONS    SIZE
  b_9f3c1a2b4d5e  Q3 planning     4        11  2.1 MB
Totals: 1 batch, 4 documents, 11 versions, 2.1 MB
Nothing was removed. Re-run with --execute to remove them permanently.
```

Archived documents become eligible for permanent removal after the deployment's retention window (30 days by default, `PURGE_RETENTION_DAYS`). `--retention-days` previews or applies a different window for one run. The deployment runs the same purge once a week from a cron trigger (`docs/RUNBOOK.md` section E), so eligible batches disappear without an operator command. To remove them sooner, run this command, read the report, and run it again with `--execute`. A removal deletes the R2 objects first, then the document and version rows, and keeps the deletion batch row as an audit record. Nobody can restore a purged batch.

## Diagnostics

`dossier health` is a hidden compatibility command that calls `/api/healthz`. It is useful for deployment smoke checks.

## Exit codes and error output

| Code | Meaning                                                                      |
| ---: | ---------------------------------------------------------------------------- |
|  `0` | Success. A diff with changes is still success.                               |
|  `1` | Operational failure, policy rejection, server error, conflict, or not found. |
|  `2` | Invalid command usage, option, reference, or configured URL.                 |
|  `4` | Authentication is missing or rejected.                                       |

### Saved-values errors

The API returns errors as `{"ok":false,"code":"<code>","message":"<message>","details":<value>}`. Contracts for simple codes allow the message and details to be absent. Contracts for errors with structured details require both. The live Worker messages below show the current text.

`state_not_enabled` and every other saved-values error in this table use CLI exit code 1. With `--json`, the CLI writes the decoded API envelope plus `"exitCode":1` to stdout. It also writes the human error to stderr.

| Code                    | HTTP | Worker message or required details                                                                                                                                                                                      | CLI rendering                                                                                                        | Exit |
| ----------------------- | ---: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---: |
| `state_not_enabled`     |  409 | `Saved values are not enabled for this document.`                                                                                                                                                                       | `state get` prints `Saved values are not enabled for this document`. Other commands print the Worker message.        |  `1` |
| `state_conflict`        |  409 | The required `details.fields` array contains `{name, revision, value}` for every conflicting field.                                                                                                                     | The CLI prints `<name>: <JSON value> (revision <n>)`, then tells the caller to read the latest values and try again. |  `1` |
| `state_schema_change`   |  409 | The required details contain `retyped: [{name, from, to}]` and `orphaned: [name]`.                                                                                                                                      | The CLI lists both groups and tells the author to re-run with `--accept-state-changes`.                              |  `1` |
| `state_version_changed` |  409 | The required details contain `currentVersion`. The message states that the document version changed before the save completed or after the page loaded.                                                                 | The CLI prints the Worker message.                                                                                   |  `1` |
| `state_type_mismatch`   |  422 | The required `details.fields` array names rejected entries. The Worker rejects unknown or duplicate names, invalid baselines or types, non-JSON values, values larger than 64 KiB, and batches larger than 200 changes. | `Values do not match the current types for: <names>`                                                                 |  `1` |
| `state_edit_required`   |  403 | `State edit access is required.`                                                                                                                                                                                        | The CLI prints the Worker message.                                                                                   |  `1` |
| `state_too_large`       |  413 | The required details contain `bytes` and `limit` when the document total would exceed 256 KiB.                                                                                                                          | `Saved values use <bytes> bytes; the limit is <limit> bytes.`                                                        |  `1` |
| `state_unavailable`     |  503 | `Saved values are temporarily unavailable.` The Worker uses this code when it cannot use the state rate limiter.                                                                                                        | The CLI prints the Worker message. A failed health check instead prints the deployment compatibility message.        |  `1` |
| `link_revoked`          |  410 | `This edit link is no longer active.`                                                                                                                                                                                   | The browser edit-link routes return this error. A CLI API failure prints the Worker message.                         |  `1` |
| `rate_limited`          |  429 | `State rate limit exceeded.` The response includes `Retry-After: 60`.                                                                                                                                                   | The CLI prints the Worker message.                                                                                   |  `1` |

The general API errors still apply. Missing or rejected authentication uses exit code 4. Invalid local command usage uses exit code 2. Unreadable documents and insufficient management permission use the existing `not_found`, `editor_required`, or `publisher_required` responses and exit code 1.

The CLI writes errors to stderr in this form.

```text
dossier: <message>
```

With `--json`, stdout still contains exactly one JSON value. Scripts should treat the exit code as the primary success signal.
