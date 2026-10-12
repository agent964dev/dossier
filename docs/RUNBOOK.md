# Dossier runbook

How to run a Dossier deployment: what it is made of, how to set up a new one,
how dossier.agent964.com is released, the launch of Dossier next, day-to-day
operations, and the dev environment.

Run commands from a clone of this repository, in the directory each step
names. Never paste a secret into chat, a log, a screenshot or an issue.

## 1. What a deployment is made of

| Part               | Production (dossier.agent964.com)                     | Dev                                      |
| ------------------ | ----------------------------------------------------- | ---------------------------------------- |
| Worker             | `dossier`                                             | `dossier-next-dev`                       |
| Main host          | `dossier.agent964.com` (custom domain)                | `dossier-next-dev.tech964.workers.dev`   |
| Content hosts      | `<tree-id>.dossier-content.com`                       | `<tree-id>-dev.dossier-content.com`      |
| Content route      | `*.dossier-content.com/*`, zone `dossier-content.com` | `*-dev.dossier-content.com/*`, same zone |
| D1 (`DB`)          | `dossier-next-production`, location `eeur`            | `dossier-next-dev`, location `eeur`      |
| R2 (`BLOBS`)       | `dossier-next-production`                             | `dossier-next-dev`                       |
| Queue (`WEBHOOKS`) | `dossier-next-production`                             | `dossier-next-dev`                       |

Both are configured in `apps/web/wrangler.jsonc`: production at the top level,
dev under `env.dev`. The dev route is more specific than production's, so
Cloudflare sends `*-dev` hosts to the dev Worker.

### The Worker and its hosts

One Worker serves the whole deployment. The main host serves Dossier's screens,
the shell, the API under `/_/api/` and the session cookie. Every tree's pages
are served from its own content host on a separate content domain, so each tree
has an origin of its own. A content host serves only page files, attachments
and the base layer, and never sets or reads a cookie. The content domain needs
one proxied wildcard DNS record, and the Worker route `*.<content domain>/*`
sends its hosts to the Worker.

### D1

D1 holds every record: people, sessions, agent keys, workspaces, trees, nodes,
versions, shares, events, forms, data values, the search index, webhooks and
their deliveries, settings and purge runs. Migrations are in `apps/web/drizzle/`
(`0000` to `0025`; some numbers are skipped). The search index includes an FTS5
virtual table (`search_pages`), which is why `wrangler d1 export` cannot export
the database and backups rely on Time Travel (section 5).

### R2

| Prefix                                   | What                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `blobs/<sha256>/<generation>`            | The bytes of file versions (`blobs/<sha256>` for rows made before generations) |
| `derived/markdown/<version>/<sha256>.md` | Markdown generated from a page for its agent version                           |
| `base/<version>/…`                       | Copies of each deployed base layer, with a `.complete` marker                  |
| `fonts/<sha256>`                         | Fonts of the Look                                                              |
| `looks/<sha256>`                         | Logos of the Look                                                              |

Only the purge deletes from `blobs/` and `derived/`. Nothing deletes `base/`,
`fonts/` or `looks/`.

### The Queue

The `WEBHOOKS` Queue carries webhook work: one message per committed change,
then one per delivery. The same Worker is its producer and its consumer
(`max_batch_size` 10, `max_batch_timeout` 5, `max_retries` 10). D1 holds each
delivery's state, and the consumer decides when a delivery has failed for good.
A deployment without the Queue binding delivers no webhooks.

### The tree hub

`TREE_HUB` binds the `TreeHub` Durable Object class, one object per tree. It
holds the WebSockets of shells and agents watching the tree and relays change
hints. It keeps no records. The class is declared by the Durable Object
migration `v1` (`new_sqlite_classes: ["TreeHub"]`).

### Static Assets and the base-layer copies in R2

The build's client files are Static Assets (`ASSETS`): the screens' code under
`/_/app/` and the base layer under `/_/base/<version>/` (the shell, the page
client, the base layout, the base components and the libraries). Static Assets
keep only the latest build, but a page opened before a deploy may still load
files of its own base-layer version. So every deploy first copies its base layer
into R2 under `base/<version>/` with `apps/web/scripts/copy-base.ts`, and the
Worker serves older versions from there. The copy skips a version R2 already
holds, so a retried deploy copies nothing twice. A new version is about 400
files and 77 MB and takes about a minute to copy.

### Schedules

| Cron           | Job                                                                        |
| -------------- | -------------------------------------------------------------------------- |
| `17 3 * * SUN` | The weekly purge, Sunday 03:17 UTC                                         |
| `*/5 * * * *`  | The webhook sweep: deliveries a lost message or a Queue outage left behind |

The Worker picks the job by the cron string, so keep both strings exactly.

### Variables

| Variable          | Example                        | Meaning                                                                |
| ----------------- | ------------------------------ | ---------------------------------------------------------------------- |
| `PUBLIC_ORIGIN`   | `https://dossier.agent964.com` | The main host's origin. Must be `https://`.                            |
| `CONTENT_HOST`    | `{tree}.dossier-content.com`   | Each tree's host. Holds `{tree}` once, in its first label.             |
| `DEPLOYMENT_NAME` | `dossier.agent964.com`         | The deployment's name on screens, in the health check and in webhooks. |

`DOSSIER_BUILD_VERSION`, read at build time, is the version the health check
reports. Without it the build uses the short git SHA of the checkout. The
release sets the full SHA.

### Secrets

Every environment has five secrets. A missing one makes the Worker answer every
request with the plain error page, or `unavailable` on `/_/api/`, and log "The
deployment is misconfigured" with the missing name. The Google values are the
exception: without them the sign-in page says that sign-in is not set up.

| Secret                 | What it does                                                     | What rotating it does                                                                                                       |
| ---------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`   | Signs session cookies and sign-in notices.                       | Ends every browser session: everyone signs in again. Agent keys keep working.                                               |
| `HANDLE_SECRET`        | Makes view handles and seals event cursors.                      | Each session gets a new view handle at its next view, and event cursors sealed earlier are refused. See below.              |
| `SUPER_ADMINS`         | Comma-separated emails made super admins at their first sign-in. | Affects only people who sign in for the first time, or come back after deleting their account. Never removes a super admin. |
| `GOOGLE_CLIENT_ID`     | The Google OAuth client.                                         | Sign-in uses the new client at once. Sessions stay.                                                                         |
| `GOOGLE_CLIENT_SECRET` | The Google OAuth client's secret.                                | Sign-in uses the new secret at once. Delete the old one in Google after setting the new one.                                |

To name or remove super admins after the first sign-in, use `/_/admin`.

Rotating `HANDLE_SECRET`: a session's view handle for a tree is computed from
the secret. At its next view of the tree, each session gets a new handle in
place of the one the old secret made. A frame still holding the old handle
answers 404, and the shell reloads the page with the new one. Event cursors
sealed under the old secret are refused as `invalid`: a `dossier watch` running
across the rotation stops, and is started again. Rotate `HANDLE_SECRET` only
when it has leaked.

## 2. Set up a new deployment (self-hosting)

These steps set up a deployment of your own from an empty Cloudflare account.
Fill in these values first and use them everywhere below:

| Placeholder         | Meaning                                                                    | Example               |
| ------------------- | -------------------------------------------------------------------------- | --------------------- |
| `<main host>`       | The host people and the CLI use                                            | `dossier.example.com` |
| `<content domain>`  | A separate domain whose subdomains serve the trees' pages                  | `example-content.com` |
| `<worker>`          | The Worker's name                                                          | `dossier`             |
| `<db>`              | The D1 database's name                                                     | `dossier`             |
| `<location>`        | Where D1 keeps its primary: `weur`, `eeur`, `apac`, `oc`, `wnam` or `enam` | `weur`                |
| `<bucket>`          | The R2 bucket's name                                                       | `dossier`             |
| `<queue>`           | The Queue's name                                                           | `dossier`             |
| `<you@example.com>` | Your Google account's email, the first super admin                         | `sara@example.com`    |

### 2.1 Accounts, domains and tools

1. A Cloudflare account on the Workers Paid plan.
2. Two domains, both added to that Cloudflare account as zones: the domain of
   `<main host>`, and `<content domain>`. Pages are served only from
   `<content domain>`, so a deployment on `workers.dev` alone cannot serve
   pages. The tree hosts are `<tree-id>.<content domain>`, one level under the
   zone, because the zone's free certificate covers the apex and one level of
   subdomains.
3. A Google account that can create a Google Cloud project.
4. On your machine: git, Bun 1.3.14, Node.js 22.12 or newer, `openssl` and
   `xh`.
5. The repository, with its dependencies, and Wrangler signed in:

   ```sh
   git clone https://github.com/agent964dev/dossier.git
   cd dossier
   bun install
   cd apps/web
   bunx wrangler login
   ```

Steps 2.4 to 2.9 run in `apps/web` with `CLOUDFLARE_ENV` unset, so Wrangler
and the build use the top level of `wrangler.jsonc`:

```sh
unset CLOUDFLARE_ENV
```

### 2.2 The content domain's DNS record

In the Cloudflare dashboard, open the DNS records of `<content domain>` and add
one record:

| Type   | Name | IPv6 address | Proxy status |
| ------ | ---- | ------------ | ------------ |
| `AAAA` | `*`  | `100::`      | Proxied      |

`100::` is a placeholder address: the Worker route answers every request, so
nothing reaches it. The zone's free Universal SSL certificate covers
`*.<content domain>`.

`<main host>` needs no record. The Worker's custom domain creates its DNS
record and certificate at the first deploy, as long as no record for that host
exists yet.

### 2.3 The Google OAuth client

In the Google Cloud console, in a project of your own:

1. Google Auth Platform, Branding: give the app a name, a support email and the
   authorized domain of `<main host>`. Set the app home page to
   `https://<main host>/` and the privacy policy to
   `https://<main host>/_/privacy`. Both answer once the deployment runs.
2. Audience: user type External. Leave the app in Testing for now and add
   `<you@example.com>` as a test user.
3. Data access: the scopes `openid`, `email` and `profile`, nothing else.
4. Clients: create an OAuth client of type Web application with the authorized
   redirect URI `https://<main host>/_/auth/callback/google`.
5. Save the client's ID and secret in a file only you can read, for example
   `~/.config/dossier-deploy/google.env`, with mode 600:

   ```sh
   GOOGLE_CLIENT_ID=…
   GOOGLE_CLIENT_SECRET=…
   ```

You publish the app in step 2.12, once `/_/privacy` answers.

### 2.4 D1, R2 and the Queue

From `apps/web`:

```sh
bunx wrangler d1 create <db> --location <location>
bunx wrangler r2 bucket create <bucket>
bunx wrangler queues create <queue>
```

`d1 create` prints the new database's `database_id`. Keep it for the next step.

### 2.5 `wrangler.jsonc`

Edit the top level of `apps/web/wrangler.jsonc` (not `env.dev`) so these keys
hold your values. Keep every binding name, class name and cron string as they
are: the code reads them.

```jsonc
  "name": "<worker>",
  "routes": [
    { "pattern": "<main host>", "custom_domain": true },
    { "pattern": "*.<content domain>/*", "zone_name": "<content domain>" },
  ],
  "vars": {
    "PUBLIC_ORIGIN": "https://<main host>",
    "DEPLOYMENT_NAME": "<main host>",
    "CONTENT_HOST": "{tree}.<content domain>",
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "<db>",
      "database_id": "<database_id from wrangler d1 create>",
      "migrations_dir": "drizzle",
    },
  ],
  "r2_buckets": [{ "binding": "BLOBS", "bucket_name": "<bucket>" }],
  "durable_objects": {
    "bindings": [{ "name": "TREE_HUB", "class_name": "TreeHub" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["TreeHub"] }],
  "queues": {
    "producers": [{ "binding": "WEBHOOKS", "queue": "<queue>" }],
    "consumers": [
      {
        "queue": "<queue>",
        "max_batch_size": 10,
        "max_batch_timeout": 5,
        "max_retries": 10,
      },
    ],
  },
  "triggers": { "crons": ["17 3 * * SUN", "*/5 * * * *"] },
```

`DEPLOYMENT_NAME` is the name people see; the main host is the usual choice.
Nothing below uses `env.dev`; leave it or delete it.

### 2.6 Secrets

From `apps/web`. Each value goes from a pipe straight to Cloudflare and is
never printed. If the Worker does not exist yet, Wrangler offers to create it;
answer yes.

```sh
openssl rand -base64 32 | bunx wrangler secret put BETTER_AUTH_SECRET --config wrangler.jsonc
openssl rand -base64 32 | bunx wrangler secret put HANDLE_SECRET --config wrangler.jsonc
printf '%s' '<you@example.com>' | bunx wrangler secret put SUPER_ADMINS --config wrangler.jsonc
( . ~/.config/dossier-deploy/google.env
  printf '%s' "$GOOGLE_CLIENT_ID" | bunx wrangler secret put GOOGLE_CLIENT_ID --config wrangler.jsonc
  printf '%s' "$GOOGLE_CLIENT_SECRET" | bunx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.jsonc )
bunx wrangler secret list --config wrangler.jsonc
```

`SUPER_ADMINS` takes several emails separated by commas. The Google values are
read in a subshell, so they never stay in your shell. `secret list` prints the
five names, never the values.

### 2.7 Migrations

From `apps/web`:

```sh
bunx wrangler d1 migrations apply <db> --remote --config wrangler.jsonc
```

Wrangler lists the migrations from `0000` to `0025` and asks before applying
them. Answer yes.

### 2.8 Build, copy the base layer, deploy

From `apps/web`, in this order:

```sh
bun run build
bun scripts/copy-base.ts --bucket <bucket> --env production
bunx wrangler deploy --config dist/server/wrangler.json
```

- `bun run build` builds the browser package, the screens and the Worker into
  `dist/`. `dist/server/wrangler.json` is the deployable configuration.
- `copy-base.ts` copies this build's base layer into R2 under
  `base/<version>/`. `--env production` means the top level of
  `wrangler.jsonc`. It prints `Copied base layer <version> into R2 (<n> files).`
  or, when R2 already holds that version, `nothing to copy`.
- `wrangler deploy` uploads the Worker and its assets, attaches the custom
  domain and the content route, registers the Queue consumer and the crons, and
  applies the Durable Object migration.

### 2.9 The health check and the content host

```sh
xh https://<main host>/_/api/health
```

The answer is `200` with:

```json
{
  "ok": true,
  "service": "dossier",
  "version": "<the build's git SHA>",
  "protocol": 1,
  "deployment": "<main host>",
  "db": "ok"
}
```

`version` is the commit the Worker was built from, `protocol` the API version
the CLI must speak, and `db: "ok"` means D1 answered. A `503` with
`"code":"unavailable"` means a variable or secret is missing; section 5 shows
how to read the logs.

Then ask a content host for a path only the main host serves:

```sh
xh -h https://releasecheck.<content domain>/_/api/health
```

`releasecheck` is a well-formed tree ID that no tree has. The answer must be a
`404` that carries `content-security-policy: sandbox allow-scripts …`,
`referrer-policy: strict-origin-when-cross-origin` and
`x-content-type-options: nosniff`, and no `set-cookie`. That proves the DNS
record, the certificate, the route and the Worker's host rule work together. A
TLS error means the DNS record or the certificate is missing. A Cloudflare
error page means the route is missing.

### 2.10 First sign-in and the first-run screen

Open `https://<main host>/` in a browser and sign in with Google as
`<you@example.com>`. Because that email is in `SUPER_ADMINS`, you are a super
admin, and Dossier sends you to `/_/admin`, which says "You are a super admin
of <main host>, named in its configuration. Choose who may create
workspaces." Choose one of:

- Only super admins,
- Listed people (emails and email domains you list),
- Anyone who signs in with Google.

Press Save. Until this is saved, the home keeps sending super admins to
`/_/admin`. The rest of `/_/admin` (health, limits, retention, super admins,
workspaces, the Look and the privacy text) appears after it.

### 2.11 A first workspace

Open `https://<main host>/_/settings` and press Create workspace. A name is 1 to
63 lowercase letters, digits and hyphens, not starting with a hyphen, and not
`api` or `cli`. You become the workspace's first admin.

### 2.12 Publish the Google app

Open `https://<main host>/_/privacy` and check that it shows the deployment's
privacy text. In the Google Cloud console, under Audience, press Publish app.
With only the basic scopes, Google publishes it without a review. Until then,
only the test users can sign in.

### 2.13 `dossier login`

On any machine with Node.js 22.12 or newer:

```sh
npm i -g @agent964/dossier
dossier login <main host>
dossier whoami
```

`login` prints a link and a code and opens the link. Check that the code
matches and press Allow. `whoami` prints
`<you@example.com> on <main host> (key "cli on <machine>")`.

### 2.14 A first push, opened in a browser

From any folder outside the repository, with `<workspace>` the workspace from
step 2.11:

```sh
mkdir -p dossier-first
printf '%s\n' '<!doctype html>' '<html lang="en"><head><meta charset="utf-8"><title>Hello</title></head>' '<body><h1>Hello</h1><p>The first page on this deployment.</p></body></html>' > dossier-first/index.html
dossier push dossier-first <workspace>/first -m "First page"
dossier read <workspace>/first/
```

`push` prints `added    index.html` and the link with `(push 1)`. The first
push to a tree name creates the tree. `read` prints the page's agent version,
Markdown starting with `# Hello`.

Open `https://<main host>/<workspace>/first/` in the browser. The shell frames
the page from `https://<tree-id>.<content domain>/_/v/…`; the browser's
developer tools show the frame's origin. For a richer first tree, push the
repository's fixture from the repository root:
`dossier push packages/cli/test/fixtures/acme <workspace>/acme`.

### The same steps on dev

For `dossier-next-dev`, every Wrangler command gets `--env dev` (or runs with
`CLOUDFLARE_ENV=dev`), and the names are the dev ones from section 1. From
`apps/web`:

| Step | Command on dev                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------- |
| 2.4  | `bunx wrangler d1 create dossier-next-dev --location eeur`, then the new id into `env.dev`      |
| 2.6  | `bunx wrangler secret list --env dev` (the secrets already exist)                               |
| 2.7  | `bunx wrangler d1 migrations apply dossier-next-dev --remote --env dev --config wrangler.jsonc` |
| 2.8  | `bun run deploy:dev` (build, base-layer copy to `dossier-next-dev`, migrations, deploy)         |
| 2.9  | `xh https://dossier-next-dev.tech964.workers.dev/_/api/health`                                  |
| 2.9  | `xh -h https://releasecheck-dev.dossier-content.com/_/api/health`                               |
| 2.10 | Sign in with a test user of the dev Google client, or use `scripts/dev-session.ts` (section 6)  |
| 2.13 | `dossier login dossier-next-dev.tech964.workers.dev`                                            |

The dev bucket and Queue are checked with `bunx wrangler r2 bucket info dossier-next-dev`
and `bunx wrangler queues info dossier-next-dev`.

## 3. dossier.agent964.com releases

A merge into `main` releases production. `.github/workflows/release-cli.yml` is
the only thing that deploys the production Worker or publishes the CLI. There
are no tags and no manual deploys.

### The workflow

All runs share the concurrency group `dossier-production`, never cancel one
another, and queue (`queue: max`). Each run has three jobs.

1. `ci` runs `.github/workflows/ci.yml` at the merged commit: release tests,
   the CLI version check, lint, format, typecheck, every package's tests, both
   builds, a pack and install of the CLI, and the Gitleaks scan (`checks` and
   `secrets`).
2. `deploy`, in the GitHub environment `production`:
   - `scripts/release/freshness.mjs`, the stale-run fence (below).
   - Requires the environment variable `WORKERS_BUILDS_DISABLED=true`, the
     variable `CLOUDFLARE_ACCOUNT_ID` and the secret `CLOUDFLARE_API_TOKEN`.
   - Builds with `DOSSIER_BUILD_VERSION` set to the full commit SHA, then
     `node scripts/release/verify.mjs config apps/web/dist/server/wrangler.json`.
   - Lists the Worker's secret names and runs `verify.mjs secrets` on them.
   - Runs `scripts/release/deploy.sh`.
   - Runs `node scripts/release/verify.mjs smoke <sha>`.
3. `publish`, only when `deploy` shipped: runs the fence again,
   `scripts/release/registry.mjs` decides whether the CLI's version is
   unpublished, builds the CLI, checks production once more with
   `verify.mjs smoke`, and runs `npm publish --provenance` through npm's
   trusted publishing (OIDC). No npm token exists.

`deploy.sh` runs, from `apps/web` with `CLOUDFLARE_ENV` unset:

```sh
bunx --no-install wrangler d1 migrations apply dossier-next-production --remote --config wrangler.jsonc --no-x-provision
bun scripts/copy-base.ts --bucket dossier-next-production --env production
bunx --no-install wrangler deploy --config dist/server/wrangler.json --no-x-provision
```

Migrations run before the new code goes live, while the previous Worker still
serves. `--no-x-provision` makes a missing database, bucket or Queue fail the
release instead of being created.

### The checks

`scripts/release/verify.mjs` reads every expectation from
`scripts/release/production.json`, so a change of resource edits that file and
`wrangler.jsonc`, and nothing else:

```json
{
  "healthUrl": "https://dossier.agent964.com/_/api/health",
  "contentProbeUrl": "https://releasecheck.dossier-content.com/_/api/health",
  "worker": "dossier",
  "origin": "https://dossier.agent964.com",
  "contentHost": "{tree}.dossier-content.com",
  "contentRoute": {
    "pattern": "*.dossier-content.com/*",
    "zone_name": "dossier-content.com"
  },
  "deployment": "dossier.agent964.com",
  "protocol": 1,
  "secrets": [
    "BETTER_AUTH_SECRET",
    "HANDLE_SECRET",
    "SUPER_ADMINS",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET"
  ],
  "d1": { "name": "dossier-next-production", "id": "<the database's id>" },
  "r2": "dossier-next-production",
  "queue": "dossier-next-production",
  "hub": { "binding": "TREE_HUB", "class": "TreeHub" },
  "crons": ["17 3 * * SUN", "*/5 * * * *"]
}
```

- `config` refuses a built configuration unless it names the Worker, the
  origin, `CONTENT_HOST`, the custom domain, the content route with its zone,
  the D1 database by name and id, the bucket, the tree hub class, the Queue's
  producer and consumer and both crons, has no rate limiter bindings, and no
  secret name among its variables.
- `secrets` requires every secret name in `production.json`.
- `smoke` asks the health URL up to 12 times, 5 seconds apart, each with 10
  seconds to answer. It requires `ok: true`, `service: "dossier"`, the exact
  full SHA as `version`, the expected `protocol` and `deployment`, and
  `db: "ok"`. Then it asks the content probe once, which must answer `404`
  with `Referrer-Policy: strict-origin-when-cross-origin`, a
  `Content-Security-Policy` holding `sandbox`, and no `Set-Cookie`.

`bun run test:release` runs these checks' own tests.

### The stale-run fence

`freshness.mjs` reads every GitHub deployment record of the `production`
environment and allows the run only if every SHA attempted so far is an
ancestor of this one, and this one is still on `main`. Failed attempts count,
because they may have applied migrations or activated code. A rerun of the same
SHA is allowed. A run whose commit is older than one already attempted fails
before it changes anything. Keep the deployment records: deleting them removes
the fence. API errors and incomplete history fail closed.

### CLI versioning

`scripts/release/cli-version.mjs` (in CI) builds the npm package of the base
and of the change, with the version number blanked, and compares them. If the
package changed, `packages/cli/package.json` must carry a higher stable
`X.Y.Z`, with `bun.lock` updated by `bun install`. A version never decreases.
Changes that leave the package unchanged need no bump.

`scripts/release/registry.mjs` publishes only a version npm does not have and
that is higher than every published version. It needs an HTTP 200 package
document from the registry to decide; any other answer fails the run. An
already published version is skipped, so a rerun is safe. Published versions
never change: fix a published CLI with a new version.

### The Cloudflare token

The `production` environment holds `CLOUDFLARE_ACCOUNT_ID`
(`0e58a177092eae6d95ff91afd4330c72`) as a variable and `CLOUDFLARE_API_TOKEN`
as a secret. The token is limited to that account and needs:

| Scope                                          | Permission              | Used by                                 |
| ---------------------------------------------- | ----------------------- | --------------------------------------- |
| Account                                        | D1 Edit                 | Migrations                              |
| Account                                        | Workers R2 Storage Edit | The base-layer copy, the R2 binding     |
| Account                                        | Queues Edit             | The Queue producer and consumer         |
| Account                                        | Workers Scripts Edit    | Deploys and the secret name list        |
| Zones `agent964.com` and `dossier-content.com` | Workers Routes Edit     | The custom domain and the content route |
| Zones `agent964.com` and `dossier-content.com` | Zone Read               | Finding the zones                       |

npm's trusted publisher for `@agent964/dossier` is the repository
`agent964dev/dossier`, the workflow `release-cli.yml` and the environment
`production`. `main` requires the `checks` and `secrets` checks.

### Retries and recovery

- **A run failed on setup or on Cloudflare.** Fix the cause, then use Re-run
  all jobs on that run. The same SHA is tested again; applied migrations are
  skipped, a copied base layer is skipped, a published CLI is skipped.
- **A newer merge already ran.** The older run's fence refuses it. Merge a
  forward fix instead.
- **A migration failed.** The run stops at once. Earlier migrations in the
  batch may have committed: check with
  `bunx wrangler d1 migrations list dossier-next-production --remote --config wrangler.jsonc`
  from `apps/web`, fix forward with a new migration, and never edit an applied
  one.
- **Migrations applied but the deploy or the smoke check failed.** Keep the
  schema and data. Read the run's output and `wrangler tail`, then rerun or
  merge a fix. npm publication waits until production verifies.
- **`wrangler deploy` reported a Cloudflare 504 after uploading.** The version
  may be live without its Queue consumer or crons. From `apps/web`:
  `bunx wrangler triggers deploy --config dist/server/wrangler.json` after
  building that commit, or rerun the job.

Never reset D1 or recreate a resource to recover. To put older code back, see
rollbacks in section 5.

## 4. The launch of Dossier next (once)

Merging the Dossier next pull request into `main` replaces production in place:
the Worker `dossier` and its custom domain stay, its bindings move to the new
`dossier-next-production` resources, and the release publishes CLI 1.0.0.
Today's data is not migrated. It was archived before production was wiped.

### Before the merge

1. **Production secrets.** The agent set `BETTER_AUTH_SECRET`, `HANDLE_SECRET`
   and `SUPER_ADMINS`, and the Google values from
   `~/.config/dossier-next/google-production.env`. Check from `apps/web` with
   `CLOUDFLARE_ENV` unset:

   ```sh
   bunx wrangler secret list --config wrangler.jsonc > /tmp/dossier-secret-names.json
   node ../../scripts/release/verify.mjs secrets /tmp/dossier-secret-names.json
   ```

   It prints "Required production secret names are present". The old Worker
   ignores the new names until the merge deploys the new code.

2. **Resources.** From `apps/web`:

   ```sh
   bunx wrangler d1 info dossier-next-production
   bunx wrangler r2 bucket info dossier-next-production
   bunx wrangler queues info dossier-next-production
   ```

3. **The token.** The owner gives the `production` environment's
   `CLOUDFLARE_API_TOKEN` every permission in section 3, in particular Queues
   Edit, Workers R2 Storage Edit, and Workers Routes Edit on
   `dossier-content.com`.
4. **Branch protection.** `main` requires only the `checks` and `secrets`
   checks. Check with:

   ```sh
   gh api repos/agent964dev/dossier/branches/main/protection --jq .required_status_checks.contexts
   ```

5. **The pull request.** Every check passes, including the CLI version step,
   which compares 1.0.0 with main's 0.2.3.

### The merge

The owner merges the pull request. The release runs as in section 3: CI,
migrations `0000` to `0025` into `dossier-next-production`, the base-layer
copy, the deploy with the content route and the Queue consumer, the smoke
checks, and the publication of 1.0.0.

### After the merge

1. **Health.**

   ```sh
   xh https://dossier.agent964.com/_/api/health
   xh -h https://releasecheck.dossier-content.com/_/api/health
   ```

   The first shows the merge's full SHA, `protocol: 1`,
   `deployment: "dossier.agent964.com"` and `db: "ok"`. The second is a 404
   with the sandbox header and no cookie.

2. **A real Google sign-in.** Open `https://dossier.agent964.com/` and sign in
   as `malhashemi@agent964.com`. The first-run screen appears at `/_/admin`.
   Choose who may create workspaces.
3. **CLI 0.2.3's upgrade error.** In an empty folder:

   ```sh
   cd "$(mktemp -d)"
   HOME="$PWD" DOSSIER_API_URL=https://dossier.agent964.com DOSSIER_API_KEY=ds_test npx -y @agent964/dossier@0.2.3 whoami
   ```

   It prints ``dossier: This deployment runs Dossier next. Update with `npm i -g @agent964/dossier`.``
   and exits 1. Then open `https://dossier.agent964.com/cli/auth` in a
   browser, as `dossier auth login` of 0.2.3 would. The page shows the same
   sentence.

4. **npm.** `npm view @agent964/dossier version` prints `1.0.0`. Then
   `npm i -g @agent964/dossier`, `dossier login` and `dossier whoami`.
5. **Publish the Google app.** In the Google Cloud project that holds the
   production client, under Branding, set the home page to
   `https://dossier.agent964.com/` and the privacy policy to
   `https://dossier.agent964.com/_/privacy`. Then under Audience, press Publish
   app. Until then, only the test users can sign in.

### Cleanup

Once the archive of the old Dossier no longer needs them, remove the old
resources. From `apps/web` with `CLOUDFLARE_ENV` unset:

```sh
bunx wrangler secret delete SESSION_SECRET --config wrangler.jsonc
bunx wrangler secret delete LINK_SECRET --config wrangler.jsonc
bunx wrangler secret delete SEED_ADMIN_EMAIL --config wrangler.jsonc
bunx wrangler secret delete BOOTSTRAP_API_KEY --config wrangler.jsonc
bunx wrangler delete --name dossier-dev
bunx wrangler d1 delete dossier-production
bunx wrangler d1 delete dossier-development
bunx wrangler r2 bucket delete dossier-production
bunx wrangler r2 bucket delete dossier-development
```

The first four remove the old secrets from the Worker `dossier`. `delete
--name dossier-dev` removes the old dev Worker. R2 deletes only an empty
bucket: empty each one in the dashboard first. Each command asks before it
deletes.

## 5. Day-2 operations

Commands in this section run from `apps/web` with `CLOUDFLARE_ENV` unset, and
use production's names. For dev, add `--env dev` and use the dev names.

### Health

- `xh https://dossier.agent964.com/_/api/health` answers 200 while the Worker
  and D1 work.
- `/_/admin` shows a health line for super admins: Database, File storage,
  Base layer and Purge, each with what it found.

### Logs

```sh
bunx wrangler tail --config wrangler.jsonc
bunx wrangler tail --config wrangler.jsonc --format json --search "webhook"
```

Workers Logs are also on in the dashboard (`observability`). Dossier logs one
JSON line per event with a `message`:

| `message`                         | Logged when                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tree event`                      | Every change to a tree: tree, sequence, type, path, actor, key, push                                                                                                  |
| `share`                           | A share given or taken away                                                                                                                                           |
| `purge`                           | A purge run starts and ends, with its counts                                                                                                                          |
| `webhook delivery`                | Each delivery attempt and its result                                                                                                                                  |
| `webhook sweep`                   | Each sweep run                                                                                                                                                        |
| `webhook skipped`                 | A delivery dropped on its recheck: the webhook or event is gone, the tree moved, the workspace is not live, the event type is no longer chosen, or the URL is refused |
| `The deployment is misconfigured` | A variable or secret is missing or wrong                                                                                                                              |
| `Request failed`                  | An unexpected failure, with its request ID                                                                                                                            |

The request ID is Cloudflare's `cf-ray`, also sent back as `x-request-id`.

### The weekly purge and Purge now

The purge runs every Sunday at 03:17 UTC. It removes what was deleted before
the retention period, and then the bytes nothing references any more. A run
stops at its budget (800 statements or 25 seconds) and the next run goes on;
the health line says when the last run finished and what it removed.

A super admin can run it at once: `/_/admin`, Retention period, Purge now.
Purge now and the weekly run never overlap: one holds a lease for ten minutes.

### Retention

`/_/admin`, Retention period, sets how many days deleted files, folders, trees,
workspaces and data stay restorable. It starts at 30. Shortening it makes the
next purge remove more. Webhook delivery rows older than the retention period
are deleted by the sweep.

Limits (file and push sizes, push and send rates, upload and data file sizes,
workspace storage, webhooks per workspace) are in the same screen.

### Failing webhooks

A workspace's webhooks are at `/_/w/<workspace>/settings/webhooks`, for its
admins. After three failed attempts in a row, a webhook shows "Failing since
<time> · <last error>" (an HTTP status, a timeout or a network error), and its
first success clears it. Each delivery is tried up to nine times, after 30
seconds, 2 minutes, 10 minutes, 30 minutes, then 1, 3, 6 and 12 hours, about
22 hours in all, and then it has failed for good. A receiver must answer within
10 seconds with a 2xx.

To look into one, `wrangler tail` with `--search "webhook delivery"` shows
each attempt. Editing the URL resets the webhook's health. Roll secret gives a
new secret at once; receivers that check the old one refuse every delivery
until they have the new one.

The sweep runs every five minutes and covers deliveries a lost Queue message
left behind. If the Queue's consumer is missing (after a deploy that hit a
Cloudflare 504), `bunx wrangler triggers deploy --config dist/server/wrangler.json`
after a build of the deployed commit attaches it again.

### Backups and restores with D1 Time Travel

D1 keeps every change for 30 days on Workers Paid, and Time Travel restores the
database to any minute in that window. `wrangler d1 export` does not work for
this database, because the search index is an FTS5 virtual table.

```sh
bunx wrangler d1 time-travel info dossier-next-production --config wrangler.jsonc
bunx wrangler d1 time-travel info dossier-next-production --timestamp=2026-10-12T09:00:00Z --config wrangler.jsonc
bunx wrangler d1 time-travel restore dossier-next-production --timestamp=2026-10-12T09:00:00Z --config wrangler.jsonc
```

The restore prints a bookmark of the state before it; restoring to that
bookmark (`--bookmark=<bookmark>`) undoes it. Before restoring:

- R2 is not restored. A file's bytes stay in R2 until a purge removes them, so
  restore to a point after the last purge run when you can. Rows that a
  restore brings back for bytes a purge already removed cannot be opened.
- Composed pages are cached for up to a day under the tree's sequence. After a
  restore, a new push reuses sequence numbers, so a page may show an older
  composition for up to a day.

### Migrations

A migration must work with both the running Worker and the new one, because
the release applies it before the new code goes live. Add tables and nullable
or defaulted columns, deploy code that uses them, and remove old shapes only in
a later release once no deployed code reads them. Never edit a migration that
has been applied anywhere.

Generate one from the schema with `bun run --cwd apps/web db:generate`. Write
triggers and FTS changes by hand with `bunx drizzle-kit generate --custom` from
`apps/web`. drizzle-kit names its file after the journal's entry count, which
is lower than the last number because numbers were skipped: rename the new file
to the next free number and restore any snapshot it overwrote from git.

### Rolling back code

```sh
bunx wrangler deployments list --config wrangler.jsonc
bunx wrangler rollback <version-id> --config wrangler.jsonc --message "<why>"
```

A rollback changes only the code. D1 stays as it is, so roll back only to code
that works with the current schema; after a migration that older code cannot
read, fix forward instead. Older base layers are still in R2, so pages keep
loading. The health check then shows the older SHA, and the next merge deploys
forward again. Prefer a forward fix.

### The Look and the privacy text

Both are super admin settings and need no deploy.

- `/_/admin/look` sets the name in the header, the logo, the palette, fonts and
  radius of Dossier's own screens. Save refuses a Look whose text fails the
  contrast checks. Reset returns to agent964's Look. Pages never receive the
  Look.
- `/_/admin`, Privacy page, replaces the generated text of `/_/privacy` (up to
  20,000 characters). Reset, or saving it empty, returns to the generated text,
  which names the deployment and what Dossier stores. Google's consent screen
  links to this page, so keep it accurate.

## 6. The dev environment

### dossier-next-dev

`dossier-next-dev` runs at `https://dossier-next-dev.tech964.workers.dev`, and
its trees at `https://<tree-id>-dev.dossier-content.com`. Its D1 database, R2
bucket and Queue are all `dossier-next-dev`. Its Google client is in Testing,
so only its test users can sign in with Google. Its secrets are the same five
names, with values of its own.

Deploy the current checkout from the repository root:

```sh
bun run deploy:dev
```

That runs `apps/web`'s `deploy:dev`: `CLOUDFLARE_ENV=dev vite build`, the
base-layer copy (`bun scripts/copy-base.ts --bucket dossier-next-dev --env dev`),
`wrangler d1 migrations apply dossier-next-dev --remote --env dev`, and
`wrangler deploy --env dev`. The base layer is copied before the deploy, so open
pages keep their version.

### A local Worker

The local Worker serves the main host at `https://localhost:8787` and each tree
at `https://<tree-id>.content.localhost:8787`, which every browser resolves to
this machine.

1. Trust mkcert's certificate authority once, then make the certificate at the
   repository root:

   ```sh
   brew install mkcert nss
   mkcert -install
   mkcert -key-file .certs/localhost-key.pem -cert-file .certs/localhost.pem localhost '*.content.localhost'
   ```

2. Copy `apps/web/.dev.vars.example` to `apps/web/.dev.vars` and fill in the
   two secrets (`openssl rand -base64 32`), your email in `SUPER_ADMINS`, and,
   to sign in with Google locally, a client whose redirect URI is
   `https://localhost:8787/_/auth/callback/google`. `.dev.vars` sets
   `PUBLIC_ORIGIN`, `CONTENT_HOST` and `DEPLOYMENT_NAME` over the dev values.
3. Apply the migrations to local D1, from `apps/web`:

   ```sh
   bunx wrangler d1 migrations apply dossier-next-dev --local --env dev --config wrangler.jsonc
   ```

4. Run the Worker from the repository root:

   ```sh
   bun run --cwd apps/web dev:https
   ```

`dev:https` builds with `CLOUDFLARE_ENV=dev`, writes
`dist/server/wrangler.local.json` without routes
(`apps/web/scripts/local-config.ts`; Wrangler would otherwise rewrite every
local request to the first route's host), and runs `wrangler dev
--local-protocol https`. Local state is kept in `apps/web/.wrangler/state`. The
Queue runs locally; crons do not fire. The build copies `.dev.vars` into
`dist/server/`, so rebuild after changing it. Restart `dev:https` after
rebuilding `dist/` while it runs.

`bun run --cwd apps/web dev` (Vite's dev server) does not serve the base layer,
so pages do not open there. Use `dev:https`.

The CLI talks to the local Worker once Node trusts mkcert's authority:

```sh
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
dossier login https://localhost:8787
```

### People for checks: `scripts/dev-session.ts`

Checks that need a signed-in person use `apps/web/scripts/dev-session.ts`. From
the repository root:

```sh
bun apps/web/scripts/dev-session.ts --email someone@example.com --name "Someone" --super-admin
bun apps/web/scripts/dev-session.ts --email someone@example.com --remote
```

It writes, with `wrangler d1 execute`, a person, a stand-in Google account, a
browser session and an agent key, and prints the session cookie
(`__Secure-dossier.session_token=…`) and the `dsk_` key. `--super-admin` also
makes the person a super admin.

- Without `--remote` it writes local D1 (`apps/web/.wrangler/state`) and signs
  the cookie with `BETTER_AUTH_SECRET` from `apps/web/.dev.vars`.
- With `--remote` it writes the `dossier-next-dev` database and signs with
  `BETTER_AUTH_SECRET` from `.dev-next-secrets.local` at the repository root
  (gitignored, one line `BETTER_AUTH_SECRET=…`).

It refuses every other target: the database name is fixed to
`dossier-next-dev`, and it never touches production. It is not part of the
Worker's build and adds no route. Set the cookie in a browser for the main host
(secure, HTTP only, SameSite Lax), or use the key with
`DOSSIER_DEPLOYMENT` and `DOSSIER_KEY`. Revoke keys in `/_/settings` when the
check is done.
