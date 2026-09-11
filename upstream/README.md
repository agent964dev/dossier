# Postplan

Postplan is a small service and CLI for publishing static HTML drafts from agents.

## CLI

Upload a draft:

```sh
npx postplan upload ./plan.html
```

Attach an optional stable description (a short label shown in your dashboard and `postplan list`). Re-running with `--description` updates it; omitting it leaves the existing one untouched:

```sh
npx postplan upload ./plan.html --description "Q3 warehouse migration plan"
```

The CLI defaults to `https://postplan.dev`. Use `--api-url http://localhost:3000` for a local or custom deployment.

API keys are optional for private/admin flows. Log in interactively (opens a browser page that mints a key you paste back — works over SSH, no localhost redirect):

```sh
npx postplan auth login
```

Or set a key directly:

```sh
npx postplan auth set <api-key>
```

List the drafts published to your account (requires an API key). Each row shows the auto-linked git repo, latest version, total version count, and last-updated time:

```sh
npx postplan list
```

The CLI stores optional credentials and draft mappings in `~/.postplan`.

## Environment

Required service variables:

- `DATABASE_URL`
- `POSTPLAN_BOOTSTRAP_API_KEY`
- `AWS_ENDPOINT_URL`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_S3_BUCKET_NAME`
- `AWS_DEFAULT_REGION`

Optional service variables:

- `POSTPLAN_PUBLIC_BASE_URL` - set to a normal base URL for `/d/<draft-id>` URLs, or a wildcard URL such as `https://*.postplan.dev` for draft subdomains.
- `POSTPLAN_SESSION_SECRET` - together with `POSTPLAN_PUBLIC_BASE_URL`, enables web sign-in (the dashboard and `/cli/auth`). If either is absent, those routes return 503 and uploads/serving are unaffected.
- `SHOO_BASE_URL` - identity broker for web sign-in (default `https://shoo.dev`).
- `MAX_HTML_BYTES`
- `UPLOAD_IP_RATE_LIMIT_WINDOW_MS`
- `UPLOAD_IP_RATE_LIMIT_MAX`
- `UPLOAD_RATE_LIMIT_WINDOW_MS`
- `UPLOAD_RATE_LIMIT_MAX`

Uploads are public by default. Bearer API keys are still used for admin endpoints and authenticated ownership flows. The bootstrap key is inserted into Postgres on startup if present.

## Dashboard & web sign-in

With `POSTPLAN_SESSION_SECRET` set, `/dashboard` lists the signed-in account's drafts (grouped by git repo, with descriptions and version history) and `/cli/auth` mints API keys for `postplan auth login`. Sign-in is delegated to [shoo](https://github.com/pingdotgg/shoo) — postplan is auto-registered as a client by its origin, exchanges the OAuth code server-side (PKCE S256), verifies the ES256 `id_token` against shoo's JWKS, and keys accounts off the stable `pairwise_sub` claim (stored in the `identities` table). Postplan then runs its own 30-day HMAC-signed session cookie; it never sees Google credentials. Dashboard pages are apex-domain only — draft subdomains cannot serve them.

Sign-in requests shoo's `pii` consent, so each user approves sharing their email, name, and profile picture once. Those claims are stored on `identities` and overwritten from the token at every login — removing your picture or email at Google clears it here too (only the stable `pii_subject` identifier is retained across logins). The header shows the avatar and email. To find the email behind an upload, join `draft_versions.created_by_api_key_id → api_keys.account_id → identities.email` — nothing is denormalized onto version rows. Declining consent denies the sign-in.

An uploaded draft is attributed to whichever account's API key published it (anonymous uploads still work and stay public, but are not attributed to any account). `GET /api/drafts` returns the authenticated account's drafts — newest first, with each draft's description, auto-linked git repo, latest version number, and total version count — which is what `postplan list` and the dashboard read.

Each uploaded version also records provenance and audit metadata: the client IP (from Railway's `X-Real-IP`), the Railway request id (`X-Railway-Request-Id`, for correlating with network logs), git branch/commit/subject and whether the working tree was dirty, CI run URL and actor when published from CI, and content signals derived at upload time (whether the HTML contains inline script, and which external hosts its images load from). Git and CI values are self-reported by the client and are used for display and audit only — never for authorization.

Uploaded HTML may contain inline classic JavaScript (`<script>...</script>`). External script sources, module scripts, inline event-handler attributes, JavaScript URLs, forms, iframes/embeds, and meta-refresh redirects are rejected at upload time. That upload-time policy is the safeguard; once stored, a draft is served verbatim.

## Serving

Every draft URL serves the exact uploaded HTML, byte for byte, to every client — browsers, `curl`, agent fetch tools, and HTTP libraries alike. There is no browser detection, no wrapper page, and no consent interstitial: a draft URL is just its HTML, so an agent that fetches one always gets the content a user uploaded. Responses carry `X-Postplan-Draft-Id` and `X-Postplan-Draft-Version` headers.

Responses also set a Content-Security-Policy. The CSP never changes the bytes a client reads, so it does not gate content for `curl` or agents in any way; it only constrains what the page may do if a human opens it in a browser — `script-src 'none'` blocks script execution, `connect-src 'none'` blocks network requests, and `form-action 'none'` blocks form posts.

The upload API returns both `publicUrl` and `rawUrl`, and the CLI prints the raw URL as `Raw HTML`. With wildcard draft domains the raw URL uses the stable apex form (`https://postplan.dev/d/<draft-id>/raw`). The `/raw` suffix is an alias kept for the API and CLI; it serves the same bytes as the canonical URL:

- `https://<draft-id>.postplan.dev/` (or `/raw`)
- `https://<draft-id>.postplan.dev/v/<n>/raw`
- `https://postplan.dev/d/<draft-id>/raw`
- `https://postplan.dev/d/<draft-id>/v/<n>/raw`

## Railway Provisioning

After `railway login` succeeds, provision and deploy the first-pass stack:

```sh
chmod +x scripts/provision-railway.sh
scripts/provision-railway.sh
```

The script creates a Railway project, app service, Postgres service, object storage bucket, service variables, Railway domain, and first deployment. It stores the generated bootstrap API key under `~/.postplan/deployments/`.

Verify the deployed service:

```sh
POSTPLAN_URL=https://your-railway-domain \
POSTPLAN_API_KEY=your-bootstrap-or-cli-key \
scripts/verify-deployment.sh
```

Create a named key from the bootstrap key:

```sh
curl -X POST "$POSTPLAN_URL/api/api-keys" \
  -H "Authorization: Bearer $POSTPLAN_BOOTSTRAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"local-cli"}'
```
