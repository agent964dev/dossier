# Dossier architecture

Dossier is a Bun workspace built around one Cloudflare Worker. The Worker
publishes versioned HTML documents, reusable assets, and a TanStack Start
management application. Effect owns the HTTP and service boundary, D1 stores
metadata, and R2 stores immutable document and asset bytes.

## Repository layout

```text
apps/web/               TanStack Start app and custom Worker entry
  src/worker.ts         Routes API, document, asset, and auth requests
  src/api/              Effect HttpApi definitions and handlers
  src/services/         Publish, access, tree, asset, session, and config logic
  src/db/               Drizzle schema and database queries
  src/routes/           Dashboard, hub, auth, and workspace pages
  src/components/       React and shadcn components
  src/styles/           Design tokens and application styles
  public/fonts/         Bundled WOFF2 fonts
  drizzle/              Generated D1 migrations
  test/                 Vitest suites running under workerd
packages/policy/        Runtime-neutral HTML and CSS policy
packages/contracts/     Shared Effect Schema API contracts
packages/cli/           Public @agent964/dossier command-line client
docs/                   Architecture, CLI reference, and production runbook
```

Effect `HttpApi` declares the API once. The Worker turns it into a fetch
handler, while the CLI derives a typed client from the same contract. Effect
services receive D1, R2, rate limiting, configuration, and clock dependencies
through layers, which lets tests substitute implementations without mocking
Worker globals.

TanStack Start renders the dashboard, document hubs, CLI authentication, and
workspace settings. Its loaders call the same services in-process. The custom
Worker entry routes `/api`, `/d`, `/a`, and `/auth` before handing remaining
requests to TanStack Start.

Document serving never transforms stored bytes. The Worker streams the R2 body
and adds the serving headers. Bun runs workspace scripts and builds the CLI,
but the published CLI remains compatible with Node 22.12 or newer. Worker tests
use workerd because Bun does not emulate D1, R2, or Worker bindings.

## Data model

![Dossier entity relationships](diagrams/er.svg)
Workspaces own documents and assets. Accounts join workspaces through
memberships, authenticate through identities or API keys, and author documents.
Each document points at its current immutable version and may have a parent,
visibility boundary, shares, deletion batch, or disabled timestamp. Assets
also have immutable numbered versions.

Document ancestry is materialized as a bounded path with a maximum depth of 16.
All mutations preserve workspace ownership, prevent cycles, and update parent,
path, and depth together. A document may have a different author from its
parent; tree organization does not transfer editorship.

## Access boundary

For a document, the effective boundary is the first node at or above it with an
explicit `visibility`. That node supplies both visibility and shares. If no node
sets visibility, the fallback is `team` with no invited addresses.

An explicit boundary replaces its inherited boundary rather than merging with
it. Clearing visibility to inherit also deletes that node's shares. Applying a
share delta to an inheriting node first materializes the effective visibility
and invite list on that node, applies the delta, and increments its revision.

Hierarchy is organizational, not confidential. A public child beneath a
private parent appears as a virtual root without exposing the parent. Access is
also document-wide: the current effective boundary governs every retained
version, including pinned version URLs.

`private` permits the author, workspace administrators, and invited verified
email addresses. `team` additionally permits workspace members. `public`
permits anonymous document serving.

## Read and write rules

Content is readable only when the target node itself is neither deleted nor
disabled and at least one condition holds:

- the viewer is an editor of the document;
- the effective visibility is `public`;
- the visibility is `team` and the viewer belongs to the workspace; or
- a verified viewer email is in the effective invite list.

Ancestor deletion and disable state do not make a live child unavailable;
ancestors are consulted only to resolve the access boundary. List and tree
queries apply the same access predicate before pagination.

Editor management is separate from content reading. Detail, trash, restore,
enable, and share operations authorize editorship and the requested state
transition directly. Deleted or disabled content still serves as 404, including
to an editor.

## HTTP error contract

| Surface                                                                       | Credentials               | Unreadable or missing | Not editor            |
| ----------------------------------------------------------------------------- | ------------------------- | --------------------- | --------------------- |
| `/api/*`                                                                      | 401 `unauthenticated`     | 404 `not_found`       | 403 `editor_required` |
| `/d/*`, cookie                                                                | anonymous; private is 404 | 404 page              | n/a                   |
| `/d/*`, Bearer                                                                | invalid token is 401      | 404 page              | n/a                   |
| `/a/*`                                                                        | public by link            | 404                   | n/a                   |
| API 401 responses include `WWW-Authenticate: Bearer`. Other stable codes are  |
| 403 `publisher_required`; 409 `has_children`, `slug_taken`, `conflict`, or    |
| `idempotency_conflict`; 413 for oversized bodies; 422 for policy rejection;   |
| and 429 with `Retry-After`. Anonymous API requests remain 401 even for public |
| documents; anonymous content reads use `/d`.                                  |

## Delete, restore, and disable

![Subtree deletion behavior](diagrams/delete.svg)
Deleting a document selects that node and every live descendant, regardless of
author. A multi-node deletion requires `force=1`; otherwise the API returns
409 `has_children` with document and distinct-author counts.

A fixed-size D1 batch creates a deletion-batch record and marks the selected
rows with its ID and deletion time. Descendants already in trash keep their
earlier batch. Every affected author can see their archived documents in trash.

Restore accepts a batch ID and restores exactly rows still tagged with that
batch. Only an editor of the batch root may restore it, and restore is refused
when the root's current parent is deleted. Repeated delete and restore cycles
create distinct batches. Partial restore is not supported.

Disable and enable affect one node only. A disabled node serves 404 to everyone
but remains visible to its editors in management views. R2 objects are retained
while documents are restorable.

A batch stays restorable for 30 days after it was archived; after that it is
eligible for permanent removal. Removal is an operator action, `dossier admin
purge --execute`, which is a dry run without the flag. Each deployment also
runs the same purge once a week (Sunday 03:17 UTC) from a cron trigger. Either
path removes one batch at a time under a short lease.
The purge deletes R2 objects first, in chunks, checkpointing as it goes, then
deletes the version and document rows, so a crash leaves objects gone and rows
intact and the next run finishes the job. The deletion batch row is kept as an
audit record of who archived what and when it was purged, and restore refuses a
batch once the purge has claimed it.

## Upload policy and serving CSP

`packages/policy` applies the same static HTML and CSS rules in the Worker and
CLI. Server configuration remains authoritative for size limits and host
allowlists.

HTML rejects forms, objects, embeds, applets, base elements, event-handler
attributes, `srcdoc`, meta refresh, unsafe URL schemes, excessive nesting, and
non-classic scripts. Iframes are limited to same-origin `/d/...` URLs or the
embed allowlist. External scripts require an allowed host and integrity hash.
External stylesheets must be allowlisted. Inline classic scripts remain allowed.

HTML size is measured from UTF-8 bytes. Byte order marks and line endings are
preserved, and lone surrogates are rejected.

CSS is parsed with css-tree across style elements, attributes, and uploaded CSS.
The policy inspects URLs, imports, image sets, and custom properties; decodes
escaped function names; rejects legacy executable constructs and unsafe URL
schemes; and fails closed on suspicious parser recovery nodes. External URLs
must use HTTPS on the configured allowlist or point to `/a/...`.

Served documents receive this CSP shape, with configured hosts appended to the
relevant directives:

```text
default-src 'none';
script-src 'unsafe-inline' <SCRIPT_HOST_ALLOWLIST>;
script-src-attr 'none';
style-src 'unsafe-inline' <PUBLIC_BASE_URL> <STYLE_HOST_ALLOWLIST>;
font-src <PUBLIC_BASE_URL> <STYLE_HOST_ALLOWLIST>;
img-src https: data:;
connect-src 'none'; worker-src 'none';
frame-src <PUBLIC_BASE_URL> <EMBED_HOST_ALLOWLIST>;
object-src 'none'; base-uri 'none'; form-action 'none';
sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox
```

The first-party origin comes from `PUBLIC_BASE_URL`. Style, embed, and script
hosts come from their respective Worker allowlist variables.

## Cloudflare Workers specifics

`apps/web/wrangler.jsonc` defines the custom server entry, Node compatibility,
production custom domain, Vite assets, D1 database, R2 bucket, upload rate
limiter, public configuration, and the corresponding development environment.
Secrets are set with `wrangler secret put` and override same-named variables.

Drizzle generates migrations into `apps/web/drizzle`. Apply them with Wrangler
D1 migration commands for local, development, or production targets. Runtime
multi-statement writes use `db.batch()` rather than transaction callbacks.

Vitest uses the Cloudflare plugin, applies D1 migrations in setup, and isolates
storage per test file. Browser probes exercise Chromium and WebKit against a
Wrangler development server. Deployment bootstrap uses the protected setup
endpoint through the `dossier setup` flow.

## Provenance

Dossier descends from postplan 0.0.4, released under the MIT License. The
read-only reference copy remains available in repository history at commit
`5be3f93`; current code was adapted or rewritten for the architecture above.
