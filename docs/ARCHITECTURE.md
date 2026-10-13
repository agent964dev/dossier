# Dossier architecture

Dossier hosts trees of plain HTML. A deployment is one Cloudflare Worker with a
D1 database, an R2 bucket, a Durable Object per tree and a Queue. People open
pages in a first-party shell on the deployment's main host, which frames each
page from its tree's own host on a separate content domain. Agents push, pull
and read the same trees with the CLI.

This document describes how the code is put together. The words follow
`GLOSSARY.md`. `docs/CLI.md` describes the command line and `docs/RUNBOOK.md`
how to run a deployment.

## Packages and their dependency direction

```text
packages/contracts   @dossier/contracts    no workspace dependencies
packages/html        @dossier/html         → contracts
packages/browser     @dossier/browser      → contracts, html
packages/cli         @agent964/dossier     → contracts, html (bundled)
apps/web             @dossier/web          → contracts, html, and the browser build's output
```

Nothing imports `apps/web`, and no package imports the CLI.

- **contracts** holds what both sides of a wire agree on: the Effect schemas,
  the `HttpApi` contract (`DossierApi`, every endpoint under `/_/api`), the one
  error table, names and paths (`parseTarget`, `linkFor`, tree IDs and their
  content hosts), the protocol number, search and comment shapes. Its
  `./bridge` and `./base` entries have no Effect import, so browser code uses
  them: the messages between the page client and the shell, and the base
  layer's types.
- **html** is pure code over parse5 with no I/O: analysing a page (its head,
  URLs, forms, companion link and libraries), the push rules (`checkPush`),
  composing a page into its layouts, form fields and their checks
  (`validateValues`), Markdown for agent versions, search text, planning an
  export, and rewriting links for a move. `@dossier/html/libraries` holds the
  library selectors with no imports at all.
- **browser** is the code that runs in browsers: the shell, the page client,
  the base layout, the base components (`<dossier-copy>`, `<dossier-diff>`,
  `<dossier-comments>`) and the libraries (Mermaid, Shiki, KaTeX) with single
  file builds for export. `bun scripts/build.ts` writes it to `dist/base/`. The
  Worker never imports it as code: `apps/web/vite.config.ts` runs the build and
  ships the output as Static Assets.
- **cli** is `@agent964/dossier`, built with Bun into one Node file,
  `dist/index.js`, with contracts and html bundled in.
- **apps/web** is the Worker: the edge (`src/edge`), the core services
  (`src/core`, written with Effect), Dossier's own screens (TanStack Start,
  `src/routes`, `src/server`, `src/components`), the tree hub (`src/hub`),
  the scheduled and Queue jobs (`src/jobs`), the Drizzle schema (`src/db`) and
  the D1 migrations (`drizzle/`).

## The Worker: request kinds, the caller, the error rule

`src/worker.ts` exports `fetch` (the edge's `dispatch`), `scheduled`, `queue`
and the `TreeHub` Durable Object class. Every request goes through one host
lookup, one classification and one caller rule in `src/edge/dispatch.ts`.

The host is either the main host (the host of `PUBLIC_ORIGIN`) or a tree's
content host (a host that matches `CONTENT_HOST`, such as
`<tree-id>.dossier-content.com`). Any other host gets a plain 404. A request
for a service worker script (`Service-Worker: script`) is refused with 403 on
either host.

| Kind                    | Host    | Paths                                                                  |
| ----------------------- | ------- | ---------------------------------------------------------------------- |
| `frame`                 | content | `/_/v/<handle>/<seq>/<link path>`                                      |
| `base`                  | both    | `/_/base/<version>/…`                                                  |
| `auth`                  | main    | `/_/auth/…` (Better Auth)                                              |
| `api-read`, `api-write` | main    | `/_/api/…`, by method                                                  |
| `upgrade`               | main    | `/_/api/watch` with `Upgrade: websocket`                               |
| `static`                | main    | `/_/app/…`, the screens' client build in Static Assets                 |
| `fonts`                 | main    | `/_/fonts/<sha256>.<ext>`                                              |
| `look`                  | main    | `/_/look/<version>.css`, `/_/look/logo-<sha256>`                       |
| `screen-call`           | main    | `/_serverFn/…`, TanStack server functions                              |
| `screen`                | main    | `/` and every other `/_/…` path                                        |
| `legacy`                | main    | `/api`, `/api/…`, `/cli`, `/cli/…`, and an old `ds_` key outside `/_/` |
| `link`                  | main    | everything else: `/<workspace>/<tree>/<path>`                          |

A content host answers only `frame` and `base`. Every other path there is a
plain 404.

### The caller

Each request becomes one `Caller`: a person (or none) and how they came
(`via`). `via` is `browser` (a session on the main host), `handle` (a frame
through a view handle), `agent` (an agent key, with its scope and read-only
flag), `visitor` (no one signed in) or `system` (the purge, the webhook sweep
and deliveries). Only the edge makes a caller.

- `bearerOf` in `src/edge/caller.ts` is the only reader of `Authorization`.
  Exactly `Bearer <key>` is an agent key. A header that names Bearer in any
  other way, or holds more than one credential, fails with `sign_in_required`
  before any cookie is read.
- The session cookie `__Secure-dossier.session_token` counts only when the
  request kind's rule holds: a navigation for links and screens, a same-origin
  fetch for API reads, a same-origin fetch with `Dossier-CSRF: 1` and the main
  host's `Origin` for API writes, and the main host's `Origin` for a watch
  upgrade. Otherwise the request is a visitor's.
- A visitor may carry `__Secure-dossier.visitor`, an anonymous session that
  binds their view handles to one browser and grants nothing.
- A frame never reads a cookie. Its caller comes from the view handle in its
  path.
- An API write with no person is refused before its body is read, except the
  CLI's `/_/api/device/token` and a visitor's `/_/api/view`.

### The error rule

`ERRORS` in `packages/contracts/src/codes.ts` is the one table of error codes,
each with its HTTP status and its CLI exit code. Core services fail with a
`DossierError` of one of those codes. The edge turns any failure of an API
kind into that code's status and one body:

```json
{ "error": { "code": "not_found", "message": "…", "fix": "…", "path": "…" } }
```

Missing and unreadable are the same answer (`not_found`, or `sign_in_required`
for a visitor), and a denial always names the path that was asked, never what
it resolved to. A person's denied link shows the no-access page at the asked
link with status 404, and a visitor is sent to sign in first. A screen that
fails shows the plain error page. A frame answers plain-text 404 or 503, never
a redirect to sign-in. Unexpected failures are logged with the request ID
(Cloudflare's `cf-ray`) and answer `unavailable`.

Every response gets `X-Content-Type-Options: nosniff` and a `Referrer-Policy`.
API responses carry `Dossier-Protocol: 1`, and a request that sends another
protocol number answers `protocol_mismatch`. HTML gets `no-transform`, so
Cloudflare injects nothing into a page or a screen.

## Trees, nodes, versions and blobs

- A **workspace** holds trees. Its name is unique in the deployment.
- A **tree** has a generated ID of 20 lowercase letters and digits, which is a
  valid DNS label and names its content host. `trees.authored_seq` moves with
  every change to authored files, and `trees.event_seq` with every event.
- A **node** is a folder or file at a path in one tree (`nodes`). Its `origin`
  is `authored` (made by a push) or `data` (written by a form or the page
  client, with an owner). Deleting a node sets `deleted_at`; nothing is removed
  until the purge.
- A **version** (`node_versions`) is one state of a file: a blob, the authored
  sequence it took effect at, and the push or data operation that wrote it.
  JSON data files also keep their value in D1 (`json_value`).
- A **blob** row (`blobs`) is one content hash with its size and a generation.
  Its bytes are in R2 at `blobs/<sha256>/<generation>`. Rows made before
  generations existed keep `blobs/<sha256>`. A blob the purge removed and
  someone uploads again gets a new row and generation, so a late delete never
  reaches the new bytes. Holds (`blob_holds`) keep bytes from the purge while
  an upload is in flight.
- An **analysis** (`analyses`) is derived from one blob by one analyzer and
  version: HTML analysis, JavaScript module analysis for export, and search
  text. A version bump rebuilds them lazily. Generated Markdown is stored in R2
  at `derived/markdown/<markdown version>/<sha256>.md`.

Every change to a tree goes through `TreeStore.change`: one D1 batch that holds
its writes, its events and guard rows. A guard row fails the whole batch when
what the change read no longer holds (the path's head, the caller's grant, a
blob's hold, the workspace's storage limit). Callers retry a lost batch within
a bounded time and then answer `conflict`. After a batch commits, the change
is published to the tree hub and the webhook Queue in the background.

A move rewrites paths and records the old ones (`path_aliases`,
`tree_aliases`), so a frame pinned before the move still composes at the old
paths and an old link redirects to the new one.

## Access

A role is `read`, `respond` or `write` on a node. A share gives a role to an
email, a team, the workspace or anyone. Roles given on a folder reach
everything below it, roles from several shares add up, and workspace admins
hold write on every tree in their workspace. Super admins get no content
access from being super admins.

The rule lives in one place, `src/core/access.ts`, in two shapes over the same
SQL: `Access.require(action, node)` answers one node, and `Access.readable(tree)`
is a condition that lists, search, events and watch hints AND into their
queries. Every request checks access in D1 as it stands.

- **Reach.** Read on any node includes the `_` files at its folder and above,
  up to the tree's root, so a page shared on its own renders as its author made
  it. Reach never includes data.
- **What a page carries.** A page share also carries the files the page and its
  layouts render with, and the data in its form targets for its respondents.
  `page_needs` records these per page at push time, with flags for what the
  version's pusher could read and respond to, so a share never carries more
  than its author held.
- **Data.** People's data is read through private grants or by its owner,
  never through a public share elsewhere. Respondents see their own answers and
  the shared files their forms edit.
- **Grant order.** Every grant (share, membership, team membership) is stamped
  from one counter (`grant_clock`) when it is made or changed. A frame at an
  older sequence opens a node only under grants that existed when that
  sequence was first issued to the handle, so a reader shared later cannot
  recover content replaced before the share.
- **Agent keys** may be limited to one node and to read only. A scoped key's
  reach ends at its node.
- A suspended or deleted workspace gives no grants.

The read rule is one SQL condition, and D1 limits a statement to 100 KB, 100
bound parameters and an expression depth of 100. Tests measure the widest
statements against these limits.

## Pushes

1. The CLI reads the folder, applies the ignore rules, and checks it with
   `checkPush` from `@dossier/html`.
2. `POST /_/api/pushes` stages the push: the target, the base sequence the
   folder last saw, and a manifest of paths, sizes and SHA-256 hashes. The
   Worker checks paths, write access and limits.
3. `PUT /_/api/pushes/<pushId>/blobs/<sha256>` uploads each file. It writes an
   unverified hold before any R2 write, stores the bytes with R2's own SHA-256
   check, then confirms the hold. It always answers 201, so a push never learns
   whether a hash exists elsewhere.
4. `POST /_/api/pushes/<pushId>/commit` answers `stale_head` when the
   pushed path changed since the folder's base. It checks every page of the
   tree as it will be (layouts, components, forms, companions), and reports a
   problem on a page the caller cannot read as one generic problem. It then
   writes the versions, forms, page needs, search index rows and events in one
   `TreeStore.change`. It retries a batch lost to other pushes, up to 8 tries
   within 20 seconds, then answers `stale_head` or `conflict`.

A push may carry shares (`--share`), granted in the same batch. Pushes per
agent key and other request rates are counted in D1 (`rate_counters`), so super
admins can change the limits in settings.

## Serving

### The main host and each tree's content host

The main host serves the shell, Dossier's screens, the API and the session
cookie. Each tree's pages are served from the tree's own content host, such as
`<tree-id>.dossier-content.com`. A tree's pages therefore have a real origin of
their own: they get the browser's `localStorage`, `sessionStorage` and
IndexedDB apart from every other tree, browsers cache their files, and embeds
from other sites play. Page code never reaches the viewer's session, which
lives on another site.

A content host serves page files, attachments and the base layer only. It sets
no cookie and reads none, refuses service worker scripts, and every response
carries `Content-Security-Policy: sandbox …`,
`Referrer-Policy: strict-origin-when-cross-origin` and `nosniff`. The content
domain is not on the Public Suffix List, so a cookie a page sets for the whole
domain is visible to other trees' pages. Dossier itself sets none there.

### The shell

A link to a page answers the shell: a small document from the main host with a
strict policy (`default-src 'none'`, scripts only from itself, frames only from
the tree's content origin, `frame-ancestors 'none'`). It loads
`/_/base/<version>/shell.js`, asks `POST /_/api/view` for a view grant, and
frames the page. A private page's shell is titled with the deployment's name
only; a public page's shell carries the page's title, description and preview
image for link previews.

The shell loads each page in a new iframe and adds browser history itself,
because navigating an existing frame loses its boot data and doubles history.
It keeps the address bar in step with the page, renews the view handle, and
carries out the page client's requests as the viewer.

### Frames and their sandbox

The iframe and every content response carry the same sandbox: `allow-scripts`,
`allow-same-origin`, `allow-forms`, `allow-popups`,
`allow-popups-to-escape-sandbox`, `allow-modals`, `allow-downloads`,
`allow-presentation` and `allow-top-navigation-by-user-activation`. The frame
also allows `fullscreen`, `clipboard-write`, `autoplay` and
`picture-in-picture`. A page opened in a new tab escapes the sandbox and runs
normally.

### View handles

A frame URL is `/_/v/<handle>/<seq>/<link path>`. The handle is an HMAC under
`HANDLE_SECRET` of the session (or the visitor's anonymous session), the tree
and a generation number. D1 stores only its SHA-256 and an expiry of 24 hours.
Every tab of one session shares the handle of a tree, the shell renews it, and
a lapsed handle is replaced by a new generation, so a leaked handle never works
again after it lapses. A handle made under an earlier `HANDLE_SECRET` is
replaced the same way at its session's next view. A handle is never a
credential for the API.

The sequence in the path pins the tree as it was. A caller without write opens
a node at a sequence only if the view issued it to the handle at that sequence
(`view_handle_nodes`: the page, its layouts and the files they load), if it is
unchanged since, or if the caller could read it under grants that existed when
the sequence was first issued. Write holders open any sequence. Following a
link to another page is a new view.

### Composition

The composed page is built at request time from the page, its layouts and the
kit (`compose` in `@dossier/html`). Layouts nest outermost first until one is
a complete document, and a body-only page with no layout is placed in the base
layer's minimal document. Heads merge by fixed rules, a layout's relative URLs
are rewritten to work from the page's folder, and a fragment is sealed inside
its slot. The composer marks each form with `data-dossier-form`, preloads the
libraries the page uses, and injects the page client with its boot data.

### The composed-page cache

Composed pages are kept in the Cache API under a key of the content host, the
tree, its sequence, the page path, the composer and analyzer versions and the
base layer version. The key holds nothing about the viewer, so one entry serves
everyone, and a push moves the sequence and with it every key in the tree. The
frame's ETag is derived from the key and checked before composing. Pages are
served `private, no-cache`; files at a pinned sequence `private, max-age=86400`.

### The base layer and its copies in R2

The base layer lives at `/_/base/<version>/`, where the version is the first 12
hex characters of a hash of its built files. It holds the shell, the page
client, the base layout, the base components and the libraries. The current
version is served from Static Assets with immutable caching.

Static Assets keep only the latest build, but an open page may still load files
of the version it started with. Each deploy therefore first copies its base
layer into R2 under `base/<version>/` (`apps/web/scripts/copy-base.ts`), with a
`.complete` marker written last. The `base` kind serves the current version
from Static Assets and any older one from R2. A path segment that does not
decode to a plain name answers 404 before any R2 read.

## Agent versions

A link answers an agent instead of a person when the request asks for
`text/markdown` in `Accept`, carries any `Authorization: Bearer` header, or
comes with an agent key. The agent version of a page is its companion when it
has one: the file its `<link rel="alternate">` names, else the same-name `.md`.
Otherwise it is Markdown generated from the page at push, ending with one line
that points to the page's data and comments. A folder answers what it holds
and, for write holders, its kit. A data folder answers each file with its
writer, time and push. Agent answers are `text/markdown` or JSON, `no-store`,
with `Content-Security-Policy: sandbox`. `dossier read` uses
`GET /_/api/read`, which gives the same text. A frame also answers a page's
text at its pinned sequence, which `<dossier-copy>` uses.

## Forms and data

A push analyses every form and records it (`forms`, `push_forms`). A form's
`action` names where answers go: a folder (one file per person,
`<target>/<email>.json`), a folder with `data-entries="many"` (a new entry per
send in the person's folder), or one shared `.json` file. Files a form takes are
uploaded first (`PUT /_/api/data/upload`) into the person's folder.

`POST /_/api/data/send` checks the send against the form as the person saw it
(the sequence in the view) and as it is now: respond access, closing, and the
field rules of `validateValues`. Each write is a `TreeStore.change` with an
operation ID (`operations`), so a retried send is stored once, and it retries
when it loses a race. Data nodes belong to their writer. Every revision is
kept, sends to a shared file merge per field, and a withdrawal removes the
person's own answer with its revisions, leaving a line in history. Data file
size, upload size and workspace storage are limits a super admin can change;
storage is checked by a guard row inside the batch.

A JSON field (a hidden input marked `data-type="json"`) is one field like any
other: it is recorded in the form's schema with type `json`, its value must be
a JSON object (`validateValues` and `validateSend` refuse anything else), and
it can never be required. It goes through the same target, owner and form
checks as the form's other fields, so it changes what a value may hold, never
where a write may go.

People who may read a page's answers see them at
`/_/responses/<workspace>/<tree>/<page>`, and a listing shows how many there
are.

## The page client and the shell

Every composed page loads `client.js`, the page client, as `window.dossier`
(`read`, `watch`, `write`, `withdraw`, `upload`, `me`, `page`). It talks to the
shell over a `MessageChannel` port. The page sends a hello, and the shell
answers once it has confirmed the page: the top page by the path its grant
named, a nested page by a view of its own for the same person. The shell then
carries out each request with the viewer's session and the CSRF header, and
answers with the result or a `DossierError`.

- Page-code writes are RFC 7396 merge patches into `.json` data files. Local
  writes show at once and roll back on refusal.
- `page.link` is the page's link from the bootstrap, the address people open;
  an export keeps the link it was exported from.
- A request with no answer is sent again with the same operation ID after 1, 3
  and 9 seconds, then fails `unavailable`. Nothing is sent while offline.
- The shell keeps form drafts and sends made offline per viewer in IndexedDB
  (`dossier-shell`), and replays a kept send when the page loads again.
- Plain forms are managed by the page client with no page code: prefill,
  drafts, the status line, and `data-state`.
- Components load on first use of their tag from the closest
  `_components/<tag>.js`, and the base libraries load when the page's markup
  uses them.
- Links to other pages of the tree are handed to the shell, so each page loads
  at the tree's current push.

## Changes: events, the tree hub, watch

Every change writes events (`push`, `delete`, `restore`, `move`, `submission`,
`entry`, `withdrawal`, `data_write`, `comment`, `mention`, `share`).
`GET /_/api/events` reads a tree's events after a cursor. Cursors are opaque:
AES-GCM sealed under a key derived from `HANDLE_SECRET`, bound to the tree, the
position and the caller. One rule (`src/core/event-visibility.ts`) decides
which events a caller sees: an event on a node they read, a push that changed
something they read, or a node-less event in a folder they read.

The tree hub is a Durable Object per tree (`TREE_HUB`, class `TreeHub`). It
holds the sockets that watch the tree and keeps no records. A watch is
`GET /_/api/watch?tree=…&path=…` with `Upgrade: websocket`. The Worker checks
access, hands the socket to the hub closed to hints, checks access again, and
only then admits it. After a change commits, the Worker reads the hub's
subscribers, rebuilds each one's caller, computes in SQL which of them may see
the change's events, and the hub sends only those sockets a bare hint
(`{"type":"changed","tree","sub"}`). Clients then read the events or values
themselves. A change that takes access away closes the affected sockets with
code 4001. Clients ping every 30 seconds and fall back to polling every 10
seconds while disconnected.

The shell's watch manager serves `dossier.watch` in pages. `dossier watch` in
the CLI uses the same socket and events route.

## Webhooks

Workspace admins register webhooks in `/_/w/<workspace>/settings/webhooks`: an
HTTPS URL and the event types it takes, at most 10 per workspace by default.
The URL may not point at the deployment itself, its content domain, an IP
literal outside public unicast, or a single-label or local name. The secret
(`whsec_…`) is shown once, and "Roll secret" replaces it.

After a commit, the Worker sends one Queue message for the change's events.
The Queue consumer (the same Worker) writes one delivery row per webhook that
takes each event and sends a message per delivery. Each attempt reads the
event, tree and workspace again, signs the body with Standard Webhooks headers
(`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<HMAC-SHA256>`), and
gives the receiver 10 seconds. The body is:

```json
{
  "type": "submission",
  "timestamp": "2026-10-12T09:14:03.000Z",
  "data": {
    "deployment": "dossier.agent964.com",
    "workspace": "agent964",
    "tree": { "id": "…", "name": "acme" },
    "event": {
      "seq": 42,
      "type": "submission",
      "path": "questions/answers/sara@acme.com.json",
      "at": "…",
      "by": "sara@acme.com",
      "push": 12
    },
    "link": "https://dossier.agent964.com/agent964/acme/questions/answers/sara@acme.com.json"
  }
}
```

A failed attempt is retried after 30 seconds, 2 minutes, 10 minutes, 30
minutes, 1, 3, 6 and 12 hours: nine attempts over about 22 hours. One attempt
at a time holds a delivery (a 60-second lease). After three failures in a row
the webhook shows "Failing since" with the last error, and the first success
clears it. Every five minutes the sweep (cron `*/5 * * * *`) sends deliveries
for events of the last day that have none, sends again any delivery stuck for
10 minutes, and deletes delivery rows older than the retention period. A
deployment without the `WEBHOOKS` Queue binding delivers no webhooks.

## Search

Search covers what the caller can open, across every workspace and tree.
`GET /_/api/search?q=…&mode=titles|content&offset=…` and the `/_/search` screen
use the same service (`src/core/search.ts`).

- **Index.** `search_docs` holds one row per page (title, path, body text and
  companion text) with the FTS5 table `search_pages` over it (`unicode61`,
  diacritics removed). `search_names` holds folded folder and file names. Every
  change that writes, moves or deletes an authored page indexes it in its own
  batch. Search text is stored per blob in `analyses`.
- **Text.** Indexed text and every query are normalized the same way: NFC,
  Arabic marks and tatweel removed, alef forms folded, white space collapsed.
- **Reading.** Every statement ANDs the read rule. Candidates are then read
  again in one statement per tree and kept only if still live at the path and
  version they were found at, and each shown result passes `Access.require`.
  A companion is searched only for a caller who can read it.
- **Order.** Results are ordered by where the words matched in the row's own
  title, path and text, then by path. No rank reads FTS statistics, which would
  reveal what other documents hold.

Results come 20 a page, up to offset 180. People's data is never indexed.

## Export

`GET /_/api/export?link=…` downloads a page as one HTML file that works offline.
`Pages.export` takes the frame's composition, then `src/core/export-page.ts`
resolves every reference with a read check and `@dossier/html` plans the file:
stylesheets, images, media and fonts inlined as data, modules in an import map,
the base libraries as their single-file export builds, and the page client in
export mode with a snapshot of the data the exporter can read. The file streams
from R2 as it is written. Past 50 MiB, the largest media stay as links to the
deployment, and the `Dossier-Export-Linked` header names them. Export never
includes the Look.

## The Look

The Look is how Dossier's own screens look on a deployment: the name in the
header, a logo, a palette, fonts per role and the corner radius. It is one
deployment setting (`look`) with a version hash. `/_/look/<version>.css` serves
its variables and `@font-face` rules, and the screens' Tailwind tokens read
those variables. Fonts are copied from Google Fonts by the Worker or uploaded,
and kept in R2 under `fonts/<sha256>`. Logos are kept under `looks/<sha256>`.
Save refuses a Look whose text colours fail the contrast checks. Super admins
edit it at `/_/admin/look`, and Reset returns to agent964's Look. Pages and
exports never receive it.

## The privacy page

Every deployment serves `/_/privacy`, linked from the sign-in page and the
front page. It is plain text generated from what Dossier stores: a person's
Google identity, name and email, sessions and agent keys, what they push, send
and comment, who opened a page and when, and that Dossier's screens load
nothing from third parties. A super admin can replace the text in `/_/admin`.
An empty value returns to the generated text.

## Sign-in and agent keys

People sign in only with Google, through Better Auth on D1 (`better-auth/minimal`
with the Drizzle adapter). Its routes are under `/_/auth/`, and Google's
redirect URI is `/_/auth/callback/google`.

- A person is their email. A Google account joins a person only when Google
  vouches for the email (a Gmail address or a hosted-domain claim). A takeover
  detaches accounts that no longer own the email and revokes only the sessions
  and keys those accounts opened.
- Sessions last 30 days and renew on use once they are an hour old. The cookie
  is host-only on the main host. Database triggers refuse a session whose
  Google account is not its person's.
- Emails in `SUPER_ADMINS` become super admins at their first sign-in. Super
  admins can name others in `/_/admin`.
- `dossier login` uses device authorization: the CLI asks
  `/_/auth/device/code`, the person approves the code at `/_/device`, and the
  CLI's poll of `/_/api/device/token` mints the key. Keys start with `dsk_` and
  are stored only as their SHA-256. People also make keys, with a scope and
  read only, in `/_/settings`.
- Deleting an account withdraws the person's data, blanks their comments,
  revokes their keys and ends their sessions.

## Keeping and purging

Deleting never removes rows or bytes at once. Deleted nodes, versions, trees
and workspaces stay restorable for the retention period, 30 days unless a
super admin sets another.

The purge (`src/core/purge.ts`) runs weekly on the cron `17 3 * * SUN` (Sunday
03:17 UTC), and when a super admin presses Purge now. It removes what was
deleted before the retention period, every row that references it, holds of
expired pushes, and then blobs nothing references or holds: their R2 bytes, their
generated Markdown and their analyses. A run holds a lease in `purge_runs`,
spends at most 800 statements or 25 seconds, and leaves the rest for the next
run. A withdrawal reclaims the bytes it released at once. The purge never
touches `fonts/`, `looks/` or `base/` in R2. The last run shows in the health
line of `/_/admin`.

## CLI 0.2.x

The Dossier before this one had a different API, which CLI 0.2.x still calls.
On the main host, the edge answers `/api`, `/api/…`, `/cli`, `/cli/…`, and any
request outside `/_/` that carries an old `ds_` Bearer key, with one upgrade
error. It reads no caller, touches no D1 and sets no cookie.

- `/api` or `/cli` paths: 404 with
  `{"ok":false,"code":"not_found","message":"…"}`, the old CLI's own error
  shape. A browser `GET` of `/cli…` that accepts HTML gets the same sentence in
  the plain error page.
- Any other path with an old key: 410 with the same body.

The message is exactly:

```text
This deployment runs Dossier next. Update with `npm i -g @agent964/dossier`.
```

The workspace names `api` and `cli` are reserved, so these paths never shadow a
workspace. New keys start with `dsk_`, so the old prefix needs no reserved
path.

## Tests and where they sit

Every package runs its own Vitest suite; `bun run test` at the root runs them
all.

- `packages/contracts/src/*.test.ts`: schemas, paths and the error table.
- `packages/html/test/`: analysis, push rules, composition, forms, Markdown,
  search text and export planning, with golden fixtures in `test/fixtures/`.
- `packages/browser/test/`: the shell, the page client, forms and the base
  components in a DOM environment (happy-dom, fake IndexedDB) against a fake
  peer.
- `packages/cli/src/*.test.ts`: every verb against a fake io and server.
  `test/fixtures/` holds the trees the checks push (`acme`, `kit`,
  `comments`).
- `apps/web/test/`: the Worker under `@cloudflare/vitest-plugin`, in three
  projects. `web` runs the real edge through `SELF.fetch` with D1, R2 and the
  Cache API in Miniflare. `hub` runs real WebSocket upgrades against the tree
  hub. `dom` renders screen components in happy-dom. Sign-in runs against a
  stand-in Google that exists only in the test build.
- `scripts/release/*.test.mjs`: the release checks, run with
  `bun run test:release` (`node --test`).

There is no browser end-to-end suite. Behaviour that needs a real browser is
checked by hand in this machine's browsers against `bun run --cwd apps/web dev:https`
or the dev Worker, with people made by `apps/web/scripts/dev-session.ts`.
