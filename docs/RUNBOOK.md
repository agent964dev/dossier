# Dossier production runbook

Follow the steps in this runbook in order. Run shell commands from a clone of this repository. Never paste production secrets into chat, logs, screenshots, or a ticket. Replace `<date>`, `<version>`, `<document-id>`, and email placeholders before running commands.

## Automatic production releases

`release-cli.yml` is the sole production coordinator. A push to `main` (normally
a merged PR) calls `ci.yml` at the same commit and waits for **all** of its
`checks`, `browser`, and `secrets` jobs. This preserves lint, formatting, both
TypeScript checks, unit and browser tests, Gitleaks, both builds, and the CLI
pack/install smoke test. PRs run those checks without a production environment,
Cloudflare credentials, or OIDC publishing permission. There is no tag release
trigger and no tag is needed.

The coordinator checks out only `github.sha`, builds production with the full
SHA in `DOSSIER_BUILD_VERSION`, checks the generated production bindings and
existing secret **names**, applies pending D1 migrations, deploys Vite's generated
Worker/assets, then verifies `/api/healthz`. Health must return HTTP 200,
`ok: true`, `service: "dossier"`, that exact full SHA as `version`, and every
capability listed in `scripts/release/production.json` at that revision (currently
`state`). It tries at most 12 times, with a 10-second request timeout and 5 seconds
between attempts. Wrangler automatic resource provisioning is explicitly disabled with
`--no-x-provision`; missing D1 databases and R2 buckets must fail instead of
being recreated. This flag disables Wrangler's resource-creation path, not
Worker binding configuration. Rate-limit bindings are declared directly in
`ratelimits`, using account-unique integer namespace IDs chosen in the config;
they do not need a separate create command. See Cloudflare's
[rate-limit binding setup](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/#get-started).
A failed migration, deployment, or smoke check fails the run
and blocks npm publication. Health proves build identity and advertised bindings;
it is not an authenticated end-to-end saved-values or database-integrity test.

### Serialization and stale runs

The entire production workflow, including its reusable CI and npm job, holds
`dossier-production` concurrency with `cancel-in-progress: false` and `queue: max`.
A subsequent merge cannot cancel a migration or deployment. GitHub supports up to
100 pending runs; if that queue fills, rerun the canceled release after capacity
is available. Waiting order is FIFO by entry into the concurrency queue, which
can differ from commit order. Each normal queued merge therefore gets its own
checks and deployment; if a newer revision has already reached production, the
older run fails its stale-release guard before changing production.

Before either deployment or publication, the workflow reads **all** GitHub
`production` deployment records and requires every attempted SHA to be an
ancestor of the candidate. Failed attempts count: they might already have
migrated D1 or activated code. The candidate must also still belong to `main`.
GitHub creates the environment deployment record before starting the job, so the
fence survives a failed smoke check or interrupted run. Same-SHA retries are
allowed. API errors, unknown commits, and incomplete history fail closed. Keep
these deployment records; deleting them removes this protection. The pagination
limit is 10,000 records and deliberately requires maintenance if reached.

PR CI retains cancellation of obsolete checks. Reusable main CI has a unique
run/attempt concurrency group and cannot cancel the production coordinator.
A rerun of just the npm job repeats both the history guard and, before publishing,
the production smoke check, even if the deploy job succeeded in an older attempt.

### CLI versioning

For a releasable CLI change, explicitly increase `packages/cli/package.json`
using a stable `X.Y.Z` version, run `bun install` to update `bun.lock`, and commit
both. CI builds and packs isolated archives of the base and proposed revisions,
normalizes only the version number, and compares the actual npm payload. This
covers bundled workspace dependencies and their resolved dependencies, generated
CLI code, README, license, and packaged skills/assets. Unchanged payloads such as
web-only or test-only edits do not require a CLI release. A Bun compiler version
change also requires a bump because it changes the CLI build toolchain. A version decrease fails.
When the version already increases, the normal build and package smoke gates
still run. PR comparison uses the base and the tested synthetic merge SHA; main comparison uses the push's
before/SHA, covering a push that contains several commits.

After successful production verification, the npm job reads the public package
metadata. An existing exact version is a successful no-op. An absent version
must be greater than all published stable versions before it can be published.
Only an HTTP 200, valid package document can establish absence; 404, 401/403,
rate limiting, network errors, malformed responses, and registry failures fail
the run. The existing package must already exist on npm. A failed publish may be
retried; if npm accepted it before the job failed, the next attempt skips it.
There is no automatic version increment and no token fallback.

A previously bumped but still unpublished version can be published by a later
main release after that later revision passes all gates. This supports recovery
from a failed release. Published versions are immutable: fix a published CLI by
merging another explicit version bump. This rollout explicitly bumps the CLI
from the published `0.2.2` to `0.2.3`, including the saved-values CLI additions
from PR #8. After the merge passes CI and production verification, the same
release will publish `0.2.3` if it is still unpublished.

### First-time owner setup (before merging the CI/CD PR)

1. **Remove competing Cloudflare deployments.** In Workers & Pages → `dossier`
   → Settings → Builds, inspect the repository and production/preview triggers.
   Disconnect the production Worker from Workers Builds, including deploy hooks,
   so this workflow is its only deployment writer. A separately named development
   Worker can retain its own pipeline. Record this verification and set the
   GitHub `production` environment variable `WORKERS_BUILDS_DISABLED` to `true`.
   This is an explicit owner attestation, not an API-discovered fact. The workflow
   refuses production work until it is set.
2. **Create the GitHub environment `production`.** Set deployment branches/tags
   to **Selected branches and tags**, add a **branch** rule for `main` only, and
   allow no tags. Do not configure required reviewers or a wait timer: ordinary
   successful merges must release without manual approval. Add environment
   variable `CLOUDFLARE_ACCOUNT_ID=0e58a177092eae6d95ff91afd4330c72` (Agent964)
   and environment secret `CLOUDFLARE_API_TOKEN`. Keep the credential at environment
   scope, not repository scope. Use a dedicated token restricted to that account
   and the `agent964.com` zone: Workers Scripts Edit, D1 Edit for migrations,
   Workers R2 Storage Read for existing bucket bindings, and the zone's Workers
   Routes Edit and Zone Read for the custom domain. Add only a permission that a
   documented Wrangler operation actually requires; do not use a global API key
   or grant unrelated account-wide privileges. These API permission classes can
   authorize more than a single Worker; restrict resources as far as Cloudflare
   supports and never use that authority to recreate infrastructure. Do not store Worker
   application secret values in GitHub.
3. **Complete existing Worker prerequisites.** Use `wrangler secret list
--config wrangler.jsonc` from `apps/web` to check names. Required:
   `SESSION_SECRET`, `LINK_SECRET`, `SEED_ADMIN_EMAIL`, `BOOTSTRAP_API_KEY`.
   Set only missing values using A5. Keep the existing `LINK_SECRET` stable:
   rotating it invalidates anonymous edit links. The workflow never creates or
   rotates secrets, databases, or buckets, and never calls `/api/setup`.
   PR #8 merged as `04470e94061f2a134cbd5edb9d36a01579b10286` on 2026-09-16;
   `0004_mature_colonel_america.sql` and `STATE_RATE_LIMITER` namespace `1003`
   are already in main and will be applied by the first release. There is no
   cherry-pick dependency remaining.
4. **Authorize npm OIDC.** For `@agent964/dossier` on npmjs.com, configure a
   GitHub Actions trusted publisher with organization/user **`agent964dev`**,
   repository **`dossier`**, workflow filename **`release-cli.yml`**, and environment
   **`production`** (exact case; filename only). Enable the allowed action for
   **direct `npm publish`**; staged publishing alone is insufficient for automatic
   releases. Replace the former publisher without an environment restriction so
   historic tag workflows cannot retain publication authority. The publish job
   runs directly in `release-cli.yml`; only CI is reusable, avoiding npm's caller
   workflow identity ambiguity. It uses a GitHub-hosted Ubuntu runner, Node 24,
   npm 11.19.1, job-scoped `id-token: write`, and explicit provenance. No
   `NPM_TOKEN`, `NODE_AUTH_TOKEN`, npm-auth secret, or token-bearing `.npmrc` is
   used. Choose npm's “Require two-factor authentication and disallow tokens”
   setting. Verify the publisher in npm settings; saving it does not validate its
   identity, and the first real publish is the final OIDC integration test.
5. **Protect `main`.** Require PRs and the `checks`, `browser`, and `secrets`
   PR checks, block force pushes/deletion, and restrict bypass access. Production
   gating also happens inside the workflow, independently of branch protection.

Setup status on 2026-09-16: the owner completed the external setup. Read-only
inspection confirms the main-only `production` environment, no approval or wait
timer, the expected Cloudflare credential name and variables, required CI checks,
and protection against force pushes/deletion. The Worker lists all four required
secret names, including `LINK_SECRET` and `SEED_ADMIN_EMAIL`; values were not read.
The owner verified that Workers Builds is disconnected and npm trusted publishing
is restricted to `release-cli.yml` / `production`, with direct publication allowed
and bypass tokens disabled. Builds and npm settings are owner-verified: the
available Builds API credential returned 403, and npm publisher settings were
not accessible to the implementation session. Public health still reports
existing build `dab662e` without capabilities. Only migration 0004 is pending.
Registry metadata confirms `0.2.3` is unpublished. The first automated release
and actual npm OIDC/provenance integration remain pending; these read-only checks
did not deploy code, apply migrations, or publish a package.

### Retries, migrations, and recovery

Use **Re-run all jobs** on the main production run after fixing external setup or
an infrastructure fault. The same immutable SHA is tested again, already-applied
D1 migrations are skipped, and an already-published npm version is skipped. If a
newer SHA has attempted deployment, the old run will be rejected; merge a forward fix or
rerun the newer release. Never edit a historical migration that has been applied.

All routine schema changes must be compatible with both the currently deployed
Worker and the new Worker: add nullable/defaulted columns or tables first, deploy
code that can use both shapes, and backfill separately when needed. Destructive
changes require a separately planned later cutover after old code and rollback
candidates stop using the old schema. Migration 0004 follows the additive rollout
and initializes existing documents with saved values disabled. Migrations run
before Worker activation while the previous Worker still serves requests. A
migration failure stops immediately; earlier migrations in that batch may have
committed, so inspect the migration ledger before retrying.

If migrations succeed but deployment or smoke verification fails, preserve the
schema and data. Investigate Wrangler output and Worker logs, then retry the same
SHA or merge compatible corrected code. Do not reset D1, recreate infrastructure,
or automatically reverse migrations. Prefer a forward code fix. An emergency
code rollback is manual (C6) and safe only if that older code works with the
current schema. npm publication remains blocked until production verifies.

Official references checked for this implementation: [GitHub concurrency and
queue semantics](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency),
[GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments),
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[Cloudflare Vite environments](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/),
[Cloudflare GitHub Actions authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/),
[disconnecting Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/#disconnecting-builds),
[disabling resource provisioning](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/),
and [D1 migration tracking](https://developers.cloudflare.com/d1/reference/migrations/).

### Upgrade an existing deployment for saved values

Complete this sequence before the first code deploy that includes saved values.

1. Confirm that `apps/web/wrangler.jsonc` declares `STATE_RATE_LIMITER` for production and development as described in step A4.
2. Set a distinct `LINK_SECRET` in each environment. Step A5 covers production, and section D covers development. The `State` service belongs to `CoreServicesLive`, so requests that construct the core service layer fail when the secret is absent.
3. Let the production release coordinator apply D1 migrations before activating the new Worker, as described in A6/A7. Do not apply production migrations directly from a working checkout. Confirm that the release logs show Wrangler applying `0004_mature_colonel_america.sql`. The migration adds `document_state`, `document_state_fields`, `document_state_grants`, and `document_edit_links`. It also adds the saved-values manifest to document versions and initializes every existing document with saved values disabled.
4. Deploy the Worker and complete the health check in step A9. The response must include `"features":["state"]`.

Never reuse a `LINK_SECRET` value between environments or print either value.
The rate limiter binding is declarative, so Cloudflare provisions it during the
Worker deploy.

## A. Production cutover operator checklist

This is the historical first-install checklist, not the routine deployment path.
The production database and bucket already exist. Skip A2/A3 for this deployment;
never rerun creation to repair a release. Preserve evidence without secret values.

1. **Confirm Cloudflare access.**

   ```sh
   cd /path/to/dossier/apps/web
   bunx wrangler whoami
   ```

   Confirm that Wrangler prints the intended Cloudflare account and an authenticated user. Report the account name, account ID, and command exit status. Do not paste credentials.

2. **Create the production D1 database.**

   ```sh
   cd /path/to/dossier/apps/web
   bunx wrangler d1 create dossier-production
   ```

   Wrangler must print `Successfully created DB 'dossier-production'` and a `database_id`. Replace the placeholder in `apps/web/wrangler.jsonc` with that UUID, then report the UUID and the resulting `d1_databases` block.

3. **Create the production R2 bucket.**

   ```sh
   cd /path/to/dossier/apps/web
   bunx wrangler r2 bucket create dossier-production
   ```

   Confirm that Wrangler created `dossier-production`. Report the confirmation line.

4. **Confirm both production rate limiters.**

   Rate-limit bindings are declarative. Cloudflare provisions them when the Worker deploys.

   ```sh
   cd /path/to/dossier/apps/web
   rg -n -A 18 '"ratelimits"' wrangler.jsonc
   ```

   The production block must contain `UPLOAD_RATE_LIMITER`, namespace `1001`, limit `30`, and period `60`. It must also contain `STATE_RATE_LIMITER`, namespace `1003`, limit `60`, and period `60`. Do not copy development namespaces `1002` or `1004` into production. Paste back the production block.

5. **Set only missing production secrets.**

   Run `bunx wrangler secret list --config wrangler.jsonc` first. Run only the
   individual commands below whose secret name is absent. Preserve existing
   `SESSION_SECRET`, `LINK_SECRET`, and bootstrap credentials. Routine deployment
   must never rotate `LINK_SECRET`.

   ```sh
   cd /path/to/dossier/apps/web
   openssl rand -base64 48 | tr -d '\n' | bunx wrangler secret put SESSION_SECRET
   openssl rand -base64 48 | tr -d '\n' | bunx wrangler secret put LINK_SECRET
   bunx wrangler secret put SEED_ADMIN_EMAIL
   openssl rand -base64 48 | tr -d '\n' > ../../.prod-bootstrap-key.local
   chmod 600 ../../.prod-bootstrap-key.local
   cat ../../.prod-bootstrap-key.local | bunx wrangler secret put BOOTSTRAP_API_KEY
   stat -f '%OLp %N' ../../.prod-bootstrap-key.local
   bunx wrangler secret list
   ```

   When Wrangler prompts for `SEED_ADMIN_EMAIL`, enter the owner's verified
   production email. Production must not declare a `SEED_ADMIN_EMAIL` plaintext var: it would
   conflict with or replace the secret during deployment. On
   Linux, replace the `stat` command with
   `stat -c '%a %n' ../../.prod-bootstrap-key.local`. Confirm that the file mode
   is `600` and the secret list names `SESSION_SECRET`, `LINK_SECRET`,
   `SEED_ADMIN_EMAIL`, and `BOOTSTRAP_API_KEY` without revealing values. Report
   the mode line and secret names only.

6. **Verify production migrations through the release coordinator.**

   Merge the tested change to `main` as described in A7. The automatic release
   applies pending migrations under its freshness check and production lock,
   before deploying the Worker. Do not run a separate migration apply command.
   Confirm that the release logs mark each pending migration as applied or report
   nothing to apply. For the first saved-values release, expect
   `0004_mature_colonel_america.sql`. Record the migration names and statuses.

   After the release completes, a read-only check can confirm that nothing is
   pending at that tested revision:

   ```sh
   cd /path/to/dossier/apps/web
   bunx wrangler d1 migrations list dossier-production --remote --config wrangler.jsonc
   ```

7. **Build and deploy production through GitHub Actions.**

   Complete automatic-release setup above, then merge the compatible change to
   `main`. Follow the `Production release` run. Its build clears `CLOUDFLARE_ENV`
   to select the top-level Wrangler configuration (there is no `env.production`),
   and deploys `apps/web/dist/server/wrangler.json`. `env.dev` and its databases
   and buckets must never be used here. Record the run URL, full SHA, Cloudflare
   version ID, and smoke-check result.

8. **Run the protected setup endpoint.**

   This is one-time manual bootstrap, not a routine release step. First disable
   `release-cli.yml`, let any active release finish, and cancel queued releases.
   Use a clean checkout of the exact SHA from the last successful production
   release. Its migrations must already be applied, as verified in A6. The setup
   script checks/applies that same migration set before calling `POST /api/setup`,
   without exposing the key in curl arguments. This maintenance window prevents
   racing another release; never run the script from an untested checkout.
   Re-enable the workflow after bootstrap, before merging any further change.

   ```sh
   cd /path/to/dossier
   apps/web/scripts/setup.sh \
     --env production \
     --key-file .prod-bootstrap-key.local
   ```

   The endpoint must return this JSON.

   ```json
   {
     "ok": true,
     "workspaceId": "workspace_agent964",
     "workspaceSlug": "agent964",
     "bootstrapAccountId": "acct_bootstrap",
     "bootstrapApiKeyId": "key_bootstrap"
   }
   ```

   A rerun must return the same summary without creating duplicates. Report the JSON summary, never the key.

9. **Verify Worker health and saved-values availability.**

   ```sh
   curl --fail-with-body --silent --show-error \
     https://dossier.agent964.com/api/healthz
   printf '\n'
   ```

   The request must return HTTP 200. Its JSON must set `ok` to `true`, `service` to `dossier`, and `features` to `["state"]`. An empty `features` array means the deployed Worker cannot see `STATE_RATE_LIMITER`. Paste back the status and JSON.

10. **Verify an authenticated tree page, then archive the probe.**

    ```sh
    cd /path/to/dossier
    cat > /tmp/dossier-production-smoke.html <<'HTML'
    <!doctype html><html><head><title>Production smoke check</title></head><body>Production smoke check</body></html>
    HTML
    HEADER_FILE=$(mktemp "${TMPDIR:-/tmp}/dossier-prod-header.XXXXXX")
    chmod 600 "$HEADER_FILE"
    trap 'rm -f "$HEADER_FILE" /tmp/dossier-production-smoke.html /tmp/dossier-tree.html' EXIT HUP INT TERM
    printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < .prod-bootstrap-key.local)" > "$HEADER_FILE"
    IDEMPOTENCY_KEY="production-cutover-smoke-$(date -u +%Y%m%dT%H%M%SZ)"
    PAYLOAD=$(jq -n --rawfile html /tmp/dossier-production-smoke.html \
      --arg idempotencyKey "$IDEMPOTENCY_KEY" \
      '{html:$html,filename:"production-smoke.html",kind:"smoke",visibility:"private",idempotencyKey:$idempotencyKey}')
    RECEIPT=$(curl --fail-with-body --silent --show-error \
      --request POST --header "@$HEADER_FILE" --json "$PAYLOAD" \
      https://dossier.agent964.com/api/uploads)
    DOCUMENT_ID=$(printf '%s' "$RECEIPT" | jq -r '.document.id')
    printf 'Document ID: %s\n' "$DOCUMENT_ID"
    curl --fail-with-body --silent --show-error \
      --header "@$HEADER_FILE" --output /tmp/dossier-tree.html \
      --write-out 'Tree HTTP %{http_code}\n' \
      "https://dossier.agent964.com/d/$DOCUMENT_ID/tree"
    grep -F 'Production smoke check' /tmp/dossier-tree.html
    curl --fail-with-body --silent --show-error \
      --request DELETE --header "@$HEADER_FILE" \
      "https://dossier.agent964.com/api/documents/$DOCUMENT_ID?force=1"
    printf '\n'
    rm -f "$HEADER_FILE" /tmp/dossier-production-smoke.html /tmp/dossier-tree.html
    ```

    Confirm that the commands print a 12-character document ID, `Tree HTTP 200`, the probe title in the HTML, then archive JSON with `"ok":true`. Report those four items. Redact headers and tokens. The probe remains recoverable in trash by design.

## B. Owner handoff

Only the owner performs these steps, in this order. Every CLI command below pins the production origin and clears inherited Dossier environment credentials, so an existing development configuration cannot receive the production key or later commands.

1. **Release the CLI package automatically.**

   Explicitly bump the CLI version and lockfile in a PR as described above. After
   merging to `main`, wait for `Production release` to pass production health
   verification and publish through npm OIDC. Do not push a release tag. Confirm
   `npm view @agent964/dossier version` reports the expected version and retain
   the workflow URL.

2. **Install that exact release.**

   ```sh
   npm install --global @agent964/dossier@<version>
   dossier --version
   ```

   Confirm that `dossier --version` prints `<version>`. Report that line.

3. **Complete the first production sign-in.**

   Open <https://dossier.agent964.com>, choose **Sign in**, then **Continue with shoo**. Sign in as `<owner email>`. Shoo opens at `shoo.dev`. Its one-time consent screen identifies `https://dossier.agent964.com` and asks to share the verified email plus basic profile (name and picture). Approve it once.

   Confirm that the browser returns to the Dossier dashboard and shows workspace `agent964` with role `admin`. Report the final URL, workspace, and role, not cookies or identity tokens.

4. **Mint and store the owner's CLI key.**

   Open <https://dossier.agent964.com/cli/auth>. Enter a machine-specific **Key name**, choose **Generate key**, and copy the `ds_…` token from the **Shown once** panel.

   ```sh
   pbpaste | env -u DOSSIER_API_KEY -u DOSSIER_API_URL dossier --api-url https://dossier.agent964.com auth set
   env -u DOSSIER_API_KEY -u DOSSIER_API_URL dossier --api-url https://dossier.agent964.com whoami
   ```

   The command reads the key currently copied to the macOS clipboard without putting it in shell history. On Linux, use the clipboard tool available on that machine (for example, `xclip -selection clipboard -o | env -u DOSSIER_API_KEY -u DOSSIER_API_URL dossier --api-url https://dossier.agent964.com auth set`). Confirm that `auth set` stores the key and `whoami` prints the owner's account, workspace `agent964`, and role `admin`. Report the `whoami` output. Redact the account ID and key ID before sharing outside the team. Never paste the token.

5. **Allow outside email addresses when needed.**

   Setup already allows the `agent964.com` domain. Add an individual entry for a person outside it.

   ```sh
   env -u DOSSIER_API_KEY -u DOSSIER_API_URL dossier --api-url https://dossier.agent964.com workspace allow name@example.com --role member
   env -u DOSSIER_API_KEY -u DOSSIER_API_URL dossier --api-url https://dossier.agent964.com workspace
   ```

   Confirm that the allowlist includes `name@example.com` as `member`. Report that allowlist line. The person still needs to sign in once before appearing as a member.

## C. Day-2 operations

1. **Rotate the production bootstrap key.**

   Use the manual maintenance window and tested checkout described in A8:
   disable the coordinator, let the active release finish, cancel queued releases,
   and re-enable it after maintenance. The setup script below must use only the
   migrations already applied by that tested production release.

   This rotates both the setup-endpoint secret and the hashed `acct_bootstrap` API credential. It explicitly re-enables `key_bootstrap`. `dossier setup` never auto-unrevokes it.

   ```sh
   cd /path/to/dossier/apps/web
   NEW_KEY_FILE=$(mktemp "${TMPDIR:-/tmp}/dossier-bootstrap-key.XXXXXX")
   trap 'rm -f "$NEW_KEY_FILE"' EXIT HUP INT TERM
   openssl rand -base64 48 | tr -d '\n' > "$NEW_KEY_FILE"
   chmod 600 "$NEW_KEY_FILE"
   NEW_HASH=$(openssl dgst -sha256 < "$NEW_KEY_FILE" | awk '{print $NF}')
   cat "$NEW_KEY_FILE" | bunx wrangler secret put BOOTSTRAP_API_KEY
   bunx wrangler d1 execute dossier-production --remote --command \
     "UPDATE api_keys SET key_hash='$NEW_HASH', last_used_at=NULL, revoked_at=NULL WHERE id='key_bootstrap'"
   cp "$NEW_KEY_FILE" ../../.prod-bootstrap-key.local
   chmod 600 ../../.prod-bootstrap-key.local
   scripts/setup.sh --env production --key-file ../../.prod-bootstrap-key.local
   ```

   Confirm that Wrangler updates the secret, D1 reports one changed row, and setup returns `"ok":true`. Report statuses and setup JSON only.

2. **Rotate every anonymous edit link.**

   Each environment holds its own `LINK_SECRET`. Rotating it immediately
   invalidates every anonymous edit link in that environment. Signed-in access,
   saved values, and link-generation rows do not change. Use this only for a
   deployment-wide link reset.

   ```sh
   cd /path/to/dossier/apps/web
   openssl rand -base64 48 | tr -d '\n' | bunx wrangler secret put LINK_SECRET
   ```

   Redeploy if Wrangler does not activate the secret change automatically, then
   create a new link for each document that still needs anonymous editing. Old
   edit links answer `410 link_revoked` after the rotation, and newly created
   links work. Never print the secret value.

3. **Recover from `503 state_unavailable`.**

   Every protected API state read or write, every browser save, and every signed-in or edit-link browser state read returns `503 state_unavailable` when the Worker cannot use `STATE_RATE_LIMITER`. The Worker refuses the request rather than skipping the limit. Anonymous reads of a public document's values and direct link-management requests do not use this limiter. A missing binding also removes `state` from `/api/healthz`, so the CLI normally prints its deployment compatibility message before any state command. A binding whose `limit()` call throws can still appear in health, so inspect the Worker logs when health already lists the feature.

   ```sh
   cd /path/to/dossier/apps/web
   curl --fail-with-body --silent --show-error \
     https://dossier.agent964.com/api/healthz
   printf '\n'
   rg -n -A 18 '"ratelimits"' wrangler.jsonc
   bunx wrangler tail dossier --format pretty
   ```

   Stop the tail after capturing the failing request. If the production binding is absent, restore the `STATE_RATE_LIMITER` block with namespace `1003`, limit `60`, and period `60`. Build and redeploy the Worker.

   Merge the binding fix to `main` and follow the automatic release. Do not run
   an independent production deploy alongside the workflow.

   If the binding exists and the limiter call still fails, resolve the Cloudflare binding error shown in the tail and redeploy. Do not remove the check or install the permissive local limiter in production. Verify that health lists `state`, then repeat the failed `dossier state get <document-id> --json` or save. Paste back the health JSON, deployed version ID, and successful command output with saved values redacted when needed.

4. **Add an allowlist entry.**

   ```sh
   env -u DOSSIER_API_KEY -u DOSSIER_API_URL dossier --api-url https://dossier.agent964.com workspace allow name@example.com --role member
   env -u DOSSIER_API_KEY -u DOSSIER_API_URL dossier --api-url https://dossier.agent964.com workspace
   ```

   Confirm that the allowlist shows the normalized email and role `member`. For a whole domain, use `@example.com`. Report the added line.

5. **Restore a document subtree from trash.**

   ```sh
   dossier trash
   dossier restore <document-id> --batch <batch-id>
   dossier tree <document-id>
   ```

   Copy the root document ID and batch ID from `dossier trash`. Confirm that `restore` prints `Restored` and `tree` prints a readable tree. Report the document ID, batch ID, and both commands' output.

6. **Roll back a production deploy.**

   Prefer a revert PR on current `main` so a new SHA passes all gates and deploys
   through the normal coordinator. Preserve all applied migration files. The CLI
   version must not decrease; any changed CLI payload needs another release bump.

   For an emergency direct rollback, first disable `release-cli.yml` in Actions,
   allow any active migration/deploy to finish, and cancel pending releases. Verify
   the selected Worker is compatible with the current D1 schema. After the manual
   operation below, prepare a forward recovery/revert PR, re-enable the workflow,
   then merge that PR so its push triggers a new release. A commit merged while
   the workflow is disabled has no release run to rerun. Never use an old workflow rerun as a rollback, or delete
   deployment history to bypass its fence.

   ```sh
   cd /path/to/dossier/apps/web
   bunx wrangler versions list
   bunx wrangler rollback <known-good-version-id> \
     --message "Rollback: <incident or reason>" --yes
   curl --fail-with-body --silent --show-error \
     https://dossier.agent964.com/api/healthz
   printf '\n'
   ```

   Confirm that Wrangler activates the selected version and health returns `"ok":true`. Report the old and new version IDs, reason, and health JSON. A code rollback does not roll back D1 migrations or restore R2 data. Any database restore is a separate incident procedure requiring explicit assessment of data loss and compatibility; this pipeline never performs one.

7. **Read production logs.**

   ```sh
   cd /path/to/dossier/apps/web
   bunx wrangler tail dossier --format pretty
   ```

   Confirm that Wrangler streams live request and exception events from the production Worker. Reproduce one request, capture only relevant lines, then stop with `Ctrl-C`. Report the timestamp, request path, status, and exception text. Redact secrets, cookies, emails, and Bearer headers.

## D. Development Worker saved-values configuration

Step A5 sets the production `LINK_SECRET` and `SEED_ADMIN_EMAIL` before
deployment. Set both development values separately when preparing the
development Worker. Run these commands.

```sh
cd /path/to/dossier/apps/web
openssl rand -base64 48 | tr -d '\n' | bunx wrangler secret put LINK_SECRET --env dev
bunx wrangler secret put SEED_ADMIN_EMAIL --env dev
rg -n -A 18 '"ratelimits"' wrangler.jsonc
```

The development rate-limit block must contain `STATE_RATE_LIMITER`, namespace
`1004`, limit `60`, and period `60`. The production namespace is `1003`. Before deploying development with `SEED_ADMIN_EMAIL` as a secret, remove its
placeholder from `env.dev.vars`; a plaintext var can replace a remote secret.
Production already omits this placeholder. Localhost tests and local
development can use the permissive in-process limiter, but deployed environments
must use the Cloudflare binding.

## E. Remove archived documents from production

Archived documents become eligible for permanent removal 30 days after
archiving. The `PURGE_RETENTION_DAYS` var in `apps/web/wrangler.jsonc` sets
that window. Both environments run the purge once a week (Sunday
03:17 UTC) from the `triggers` block in that file, and an operator can run it at
any time with `dossier admin purge`. Steps 1 and 2 verify the active release
before each purge, step 3 is read-only, step 5 is a manual removal, and step 6 confirms that the
deployment runs the weekly schedule.

1. **Confirm the deployed Worker and the operator CLI support the purge.**

   The Worker reports its build's git commit as `version` in its health
   response. In Cloudflare, identify the active `dossier` Worker version and
   match its version ID to the deployment output of a **Production release**
   run. That run's production smoke check must have passed. Use its run ID below;
   `origin/main` may already contain newer commits waiting in the release queue.
   Wait for any active deployment to finish. If a failed deployment or manual
   rollback changed the active version, resolve and verify that release before
   proceeding with a purge.

   ```sh
   cd /path/to/dossier
   RELEASE_RUN_ID='replace-with-the-matching-run-id'
   PURGE_RELEASE_SHA=$(gh run view "$RELEASE_RUN_ID" --repo agent964dev/dossier --json headSha --jq .headSha)
   printf '%s\n' "$PURGE_RELEASE_SHA"
   curl --fail-with-body --silent https://dossier.agent964.com/api/healthz
   printf '\n'
   dossier --version
   dossier admin purge --help
   ```

   Confirm that the health `version` matches the full release commit that
   `gh run view` returns.
   That commit must be at or after the 0.2.0 merge (`2af0932`). Confirm that
   `dossier --version` prints 0.2.0 or newer and the help synopsis lists
   `--execute` and `--retention-days`. Report the release URL, Worker version ID,
   expected and observed commits, CLI version, and help synopsis.

   Prepare a separate worktree at that SHA for the migration check. Stop if any
   command fails; do not reuse or modify an existing checkout. If this worktree
   path already exists, choose a new unused path. This keeps local
   Wrangler configuration and migration files aligned with the verified release.

   ```sh
   cd /path/to/dossier
   git fetch origin "$PURGE_RELEASE_SHA"
   PURGE_RELEASE_WORKTREE="$(pwd)/../dossier-purge-$PURGE_RELEASE_SHA"
   git worktree add --detach "$PURGE_RELEASE_WORKTREE" "$PURGE_RELEASE_SHA"
   cd "$PURGE_RELEASE_WORKTREE"
   bun install --frozen-lockfile
   ```

   The `dossier` commands use the installed operator CLI whose version and help
   were checked above; they do not load code from the current source directory.
   Steps 3 and 5 read the existing bootstrap-key file in the original checkout.
   Do not copy that secret into this worktree. Keep these shell variables for
   the following migration check.

2. **Confirm migration 0003 on the production database.**

   Production migrations belong to the automatic release coordinator. Check the
   successful release log for `0003_skinny_pet_avengers.sql` or the message that
   no migrations remain. From that exact tested revision, list pending migrations
   without changing production:

   ```sh
   cd "$PURGE_RELEASE_WORKTREE/apps/web"
   env -u CLOUDFLARE_ENV bunx --no-install wrangler d1 migrations list dossier-production --remote --config wrangler.jsonc
   ```

   If migration 0003 is still pending, merge the compatible revision to `main`
   and let the coordinator apply it before deploying the code. Do not apply it
   through an independent terminal command. Record the release URL and migration
   statuses before running a purge.

3. **Run a dry run.**

   ```sh
   cd /path/to/dossier
   BOOTSTRAP_API_KEY=$(tr -d '\r\n' < .prod-bootstrap-key.local) \
     env -u DOSSIER_API_KEY -u DOSSIER_API_URL \
     dossier admin purge --api-url https://dossier.agent964.com
   ```

   The command is a dry run unless you pass `--execute`. The server writes
   nothing during a dry run. Add `--retention-days <n>` to preview a different
   window, and `--json` for the raw report. When batches exist, report the cutoff
   line, the table with one row per eligible batch, and the totals line. When
   none exist, the command prints only
   `No batch is past the retention window (cutoff <timestamp>).`. Report that
   single line. The empty report has no table or totals line.

4. **Review the report.**

   Read every root title in the report. Nobody can restore a purged batch. The
   purge removes the R2 objects and the document and version rows, leaving only
   the deletion batch row as an audit record. To keep a batch, restore it from
   the trash page first, then repeat step 3.

5. **Execute.**

   ```sh
   cd /path/to/dossier
   BOOTSTRAP_API_KEY=$(tr -d '\r\n' < .prod-bootstrap-key.local) \
     env -u DOSSIER_API_KEY -u DOSSIER_API_URL \
     dossier admin purge --execute --api-url https://dossier.agent964.com
   ```

   When the command removes batches, confirm that it lists the reviewed
   batches under `Purged:`. Report that line, the table, and the totals line.
   If it finds no eligible batches, report its single no-batches line instead.
   Repeat step 3 and confirm that it prints only
   `No batch is past the retention window (cutoff <timestamp>).`. Report that
   line, not a totals line. Repeat steps 3 to 5 whenever you want to empty the
   trash. A monthly check is enough.

6. **Confirm that the deployment runs the weekly cron.**

   The top level of `apps/web/wrangler.jsonc` carries
   `"triggers": { "crons": ["17 3 * * SUN"] }` beside `"routes"`. The `env.dev`
   block has the same schedule. Deploying production registers it.

   Merge the trigger change to `main` and inspect the automatic release output.

   Confirm that Wrangler reports the schedule `17 3 * * SUN` for the deployed
   version. Report the deployed version ID and the schedule line.

   To pause the schedule, set the top-level trigger to an explicit empty list
   and deploy. Leaving `triggers` out of the file does not clear a schedule
   that the deployment already runs.

   ```jsonc
   "triggers": { "crons": [] },
   ```

   Restore the cron expression and deploy to resume. The admin command keeps
   working either way.
