# Dossier production runbook

Follow the steps in this runbook in order. Run shell commands from a clone of this repository. Never paste production secrets into chat, logs, screenshots, or a ticket. Replace `<date>`, `<version>`, `<document-id>`, and email placeholders before running commands.

### Upgrade an existing deployment for saved values

Complete this sequence before the first code deploy that includes saved values.

1. Confirm that `apps/web/wrangler.jsonc` declares `STATE_RATE_LIMITER` for production and development as described in step A4.
2. Set a distinct `LINK_SECRET` in each environment. Step A5 covers production, and section D covers development. The `State` service belongs to `CoreServicesLive`, so requests that construct the core service layer fail when the secret is absent.
3. Apply the D1 migrations in step A6 before deploying the new Worker. Confirm that Wrangler applies `0004_mature_colonel_america.sql`. The migration adds `document_state`, `document_state_fields`, `document_state_grants`, and `document_edit_links`. It also adds the saved-values manifest to document versions and initializes every existing document with saved values disabled.
4. Deploy the Worker and complete the health check in step A9. The response must include `"features":["state"]`.

Never reuse a `LINK_SECRET` value between environments or print either value.
The rate limiter binding is declarative, so Cloudflare provisions it during the
Worker deploy.

## A. Production cutover operator checklist

The phase-4 integrator normally completes this section before handing the deployment to the owner. Preserve the evidence requested by each step, but redact tokens and secret values.

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

5. **Create and set the production secrets.**

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
   production email. The value in `wrangler.jsonc` is only a placeholder. On
   Linux, replace the `stat` command with
   `stat -c '%a %n' ../../.prod-bootstrap-key.local`. Confirm that the file mode
   is `600` and the secret list names `SESSION_SECRET`, `LINK_SECRET`,
   `SEED_ADMIN_EMAIL`, and `BOOTSTRAP_API_KEY` without revealing values. Report
   the mode line and secret names only.

6. **Apply the production migrations.**

   ```sh
   cd /path/to/dossier/apps/web
   bunx wrangler d1 migrations apply dossier-production --remote
   ```

   Wrangler must mark every pending migration as applied or report that there is nothing to apply. For the first saved-values deploy, confirm that the output includes `0004_mature_colonel_america.sql`. Paste back the migration names and statuses.

7. **Build and deploy production.**

   ```sh
   cd /path/to/dossier/apps/web
   bunx vite build
   bunx wrangler deploy
   ```

   Confirm that Vite builds successfully and Wrangler uploads the Worker and static assets, reports the `dossier.agent964.com` custom domain, and exits zero. Report the deployed version ID, domain, and exit status.

8. **Run the protected setup endpoint.**

   The script reapplies migrations intentionally, then calls `POST /api/setup` without exposing the key in the curl process arguments.

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

1. **Publish the CLI package.**

   Bump the exact version in `packages/cli/package.json` in the release pull
   request, then merge it to `main`. From an up-to-date `main` checkout, tag
   and push the matching release.

   ```sh
   git tag cli-vX.Y.Z
   git push origin cli-vX.Y.Z
   npm view @agent964/dossier version
   ```

   CI publishes through npm trusted publishing. Complete the one-time setup on
   npmjs.com under **Trusted publisher → GitHub Actions** with repository
   `agent964dev/dossier` and workflow `release-cli.yml`, and enable direct
   publishing. Confirm that the release workflow succeeds and `npm view` prints
   `X.Y.Z`. Report the package version and workflow URL. Never paste npm
   credentials or one-time codes.

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

   ```sh
   bunx vite build
   bunx wrangler deploy
   ```

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

   ```sh
   cd /path/to/dossier/apps/web
   bunx wrangler versions list
   bunx wrangler rollback <known-good-version-id> \
     --message "Rollback: <incident or reason>" --yes
   curl --fail-with-body --silent --show-error \
     https://dossier.agent964.com/api/healthz
   printf '\n'
   ```

   Confirm that Wrangler activates the selected version and health returns `"ok":true`. Report the old and new version IDs, reason, and health JSON. A code rollback does not roll back D1 migrations. Restore database data separately if the incident requires it.

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
`1004`, limit `60`, and period `60`. The production namespace is `1003`. Worker
secrets override variables of the same name. Localhost tests and local
development can use the permissive in-process limiter, but deployed environments
must use the Cloudflare binding.

## E. Remove archived documents from production

Archived documents become eligible for permanent removal 30 days after
archiving. The `PURGE_RETENTION_DAYS` var in `apps/web/wrangler.jsonc` sets
that window. Both environments run the purge once a week (Sunday
03:17 UTC) from the `triggers` block in that file, and an operator can run it at
any time with `dossier admin purge`. Steps 1 and 2 are one-time prerequisites,
step 3 is read-only, step 5 is a manual removal, and step 6 confirms that the
deployment runs the weekly schedule.

1. **Confirm migration 0003 on the production database.**

   `apps/web/scripts/setup.sh` applies remote migrations before it calls
   `POST /api/setup`, so a production setup run (steps A8 and C1) has already
   applied it. Confirm, or apply it on its own, with the same command the script
   uses.

   ```sh
   cd /path/to/dossier/apps/web
   bunx wrangler d1 migrations apply dossier-production --remote
   ```

   Confirm that Wrangler lists `0003_skinny_pet_avengers.sql` as applied or
   reports that there is nothing to apply. Report migration names and statuses.

2. **Confirm the deployed Worker and the operator CLI support the purge.**

   The Worker reports its build's git commit as `version` in its health
   response, so compare that value with the repository.

   ```sh
   cd /path/to/dossier
   git fetch origin && git rev-parse --short origin/main
   curl --fail-with-body --silent https://dossier.agent964.com/api/healthz
   printf '\n'
   dossier --version
   dossier admin purge --help
   ```

   Confirm that the health `version` matches the short commit that
   `git rev-parse` prints, or a later commit that you know the deployment runs.
   That commit must be at or after the 0.2.0 merge (`2af0932`). Confirm that
   `dossier --version` prints 0.2.0 or newer and the help synopsis lists
   `--execute` and `--retention-days`. Report the two commits, the CLI version,
   and the help synopsis.

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

   ```sh
   cd /path/to/dossier/apps/web
   bunx vite build
   bunx wrangler deploy
   ```

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
