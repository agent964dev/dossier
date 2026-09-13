# Phase 3 browser checks

These scripts use the globally installed Playwright at
`/opt/homebrew/lib/node_modules/playwright`; they do not require a workspace
dependency. They call the HTTP API directly with `DOSSIER_API_KEY` and never
invoke the Dossier CLI. The API key must be valid for the local Wrangler data;
`DOSSIER_API_KEY` may be the `BOOTSTRAP_API_KEY` value from
`apps/web/.dev.vars`. Both scripts write their latest result beneath
`apps/web/browser/results/` and
exit non-zero on a failed assertion or API response. API failures include the
HTTP status and response body.

The scripts create public probe documents and assets in the local Wrangler
state. Assets can be removed with `DELETE /api/assets/:slug`; probe documents
are left in place so the recorded result URLs stay resolvable.

## Script-managed server

The managed form starts `bun run --cwd apps/web dev` on port 8787, waits for
`/api/healthz`, and stops the process even when a check fails. Port 8787 must be
free.

```sh
DOSSIER_API_KEY='<local-api-key>' \
  node apps/web/browser/render-check.cjs --manage-server

DOSSIER_API_KEY='<local-api-key>' \
  node apps/web/browser/embed-spike.cjs --manage-server
```

The embed script restarts the server once. It first runs with an empty
`EMBED_HOST_ALLOWLIST`, then with `example.com`. It supplies the local-only
binding through `browser/vite.browser.config.mjs`; no `.dev.vars`,
`wrangler.jsonc`, package manifest, lockfile, remote resource, or deployed
Worker is changed.

## Caller-managed server

### Render check

Terminal 1:

```sh
bun run --cwd apps/web dev
```

Terminal 2:

```sh
DOSSIER_API_KEY='<local-api-key>' \
  node apps/web/browser/render-check.cjs
```

Stop Terminal 1 with Ctrl-C afterward.

### Embed spike

The two cases require different Worker bindings, so stop and restart the dev
server between them. The browser Vite config is an explicit local override for
`PUBLIC_BASE_URL` and `EMBED_HOST_ALLOWLIST`.

Empty allowlist, Terminal 1:

```sh
DOSSIER_BROWSER_EMBED_HOST_ALLOWLIST='' \
  bun run --cwd apps/web dev -- --config browser/vite.browser.config.mjs
```

Empty allowlist, Terminal 2:

```sh
DOSSIER_API_KEY='<local-api-key>' \
  node apps/web/browser/embed-spike.cjs --case empty
```

Stop Terminal 1, then start the allowlisted server:

```sh
DOSSIER_BROWSER_EMBED_HOST_ALLOWLIST='example.com' \
  bun run --cwd apps/web dev -- --config browser/vite.browser.config.mjs
```

Run the second case:

```sh
DOSSIER_API_KEY='<local-api-key>' \
  node apps/web/browser/embed-spike.cjs --case allowlisted
```

The first caller-managed invocation writes `status: "partial"`; the second
merges its case into the existing file and writes `status: "passed"` when both
cases pass. Do not run both caller-managed cases concurrently.

## Known WebKit credential behavior

`/d/:id` and `/d/:id/v/:n` serve the document bytes top-level, directly under
the section-9 sandbox CSP (there is no separate viewer wrapper or `/content`
route). The embed spike's empty-allowlist case nests one such document inside
another with a plain `<iframe src="/d/<innerId>">` (see
`fixtures/embed-same-origin.html`). Verified against `wrangler dev`
(Chromium 147.0.7727.15, Playwright WebKit 26.4): the `dossier_session`
cookie was absent from the nested `/d/<innerId>` request and from the
render check's `/a/...` stylesheet request in both engines
(`sessionCookieNotSentOnInnerNavigation: true`,
`stylesheetCookie.passed: true` in `results/embed.json` and
`results/render.json`). If a future run shows either assertion `false` for
an engine, report exactly which request carried the cookie header — the
sandboxed document still cannot read it via `document.cookie` (opaque
origin) even if the request itself did.

## Results

### `results/render.json`

A passing record means, in both Chromium and WebKit:

- `/a/<slug>.css` set the body to the expected computed OKLCH colour;
- the uploaded first-party WOFF2 produced a loaded `FontFace` and
  `document.fonts.check(...)` returned true;
- neither console messages nor `securitypolicyviolation` events reported a CSP
  violation;
- the deliberately installed `dossier_session` cookie was absent from the
  stylesheet request; and
- the served document had the opaque sandbox origin `window.origin === "null"`.

`record.navigationObservation` (not a pass/fail assertion) records what
happens when a document's own inline script sets `location =
"https://example.com/..."`: whether the top-level page stayed on the document
URL, any frame navigations, and any request made to the external origin.
Whether the platform should block a document from navigating the reader's
top-level page this way is an open owner decision. See the upload policy and
serving CSP in [`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md). This
harness does not fail the run on the outcome
either way.

### `results/embed.json`

The empty-allowlist case uploads a public inner Dossier document and a public
outer document containing `<iframe src="/d/<innerId>">`. A pass means the inner
inline script ran, the nested frame inherited an opaque sandbox, it could not
read its parent or a non-HttpOnly cookie probe, and the SameSite session cookie
was not sent on the nested navigation.

The allowlisted case uploads a static `https://example.com/` iframe and creates
an `https://example.org/` iframe dynamically. Dynamic creation lets the browser
exercise CSP even though upload policy correctly rejects a static
non-allowlisted iframe. A pass means `frame-src` contained `example.com`, the
allowlisted frame produced a navigation and remained present, and a
`securitypolicyviolation` event with `effectiveDirective: "frame-src"` blocked
`example.org`. `originInsideFrame: "null"` records that the external nested
frame inherited the outer CSP sandbox; a null inspection value with an error is
recorded but is not required for the allowlist pass criteria.

Set `DOSSIER_BASE_URL` to use another local origin. Set
`DOSSIER_FONT_SOURCE` to override the in-repo WOFF2 fixture used by the render
check. Set `DOSSIER_PLAYWRIGHT_PATH` only if the global Playwright installation
moves. For WebKit, the harness uses `DOSSIER_WEBKIT_EXECUTABLE` when set, otherwise
the verified phase-plan executable at
`/tmp/dossier-research/csp/webkit-2272/pw_run.sh` when present, and finally
Playwright's normal browser lookup.
