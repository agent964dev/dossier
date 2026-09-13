# Dossier production runbook

This runbook is ordered for a human operator or a computer-use agent. Run shell commands from a clone of this repository. Never paste either production secret into chat, logs, screenshots, or a ticket. Replace `<date>`, `<version>`, `<document-id>`, and email placeholders before running commands.

## A. Production cutover operator checklist

The phase-4 integrator normally completes this section before handing the deployment to the owner. Preserve the evidence requested by each step, but redact tokens and secret values.

1. **[x] Already done on `2026-09-13` — Confirm Cloudflare access.**

   ```sh
   cd /path/to/dossier/apps/web
   bunx wrangler whoami
   ```

   Expected: Wrangler prints the intended Cloudflare account and an authenticated user. Paste back: account name/ID and the command exit status; no credentials.

2. **[x] Already done on `2026-09-13` — Create the production D1 database.**

   ```sh
   cd /path/to/dossier/apps/web
   bunx wrangler d1 create dossier-production
   ```

   Expected: `Successfully created DB 'dossier-production'` and a `database_id`. Paste that UUID over the clearly marked placeholder in `apps/web/wrangler.jsonc`, then paste back the UUID and the resulting `d1_databases` block.

   Done: `database_id` is `72766ce3-44da-4bdd-a025-90a6ebe1e3e0` (region EEUR), already in `wrangler.jsonc`.

3. **[x] Already done on `2026-09-13` — Create the production R2 bucket.**

   ```sh
   cd /path/to/dossier/apps/web
   bunx wrangler r2 bucket create dossier-production
   ```

   Expected: Wrangler confirms that `dossier-production` was created. Paste back: the confirmation line.

   Done: bucket `dossier-production` created 2026-09-13T08:53Z.

4. **[x] Already done on `2026-09-13` — Confirm the upload rate limiter.**

   Rate-limit bindings are declarative; there is no separate Wrangler create command. The production binding is provisioned when the Worker is deployed.

   ```sh
   cd /path/to/dossier/apps/web
   sed -n '/"ratelimits"/,/^[[:space:]]*]/p' wrangler.jsonc
   ```

   Expected: `UPLOAD_RATE_LIMITER`, namespace `1001`, limit `30`, period `60`. Paste back: that block. Do not copy the development namespace `1002` into production.

5. **[x] Already done on `2026-09-13` — Create and set production secrets.**

   ```sh
   cd /path/to/dossier/apps/web
   openssl rand -base64 48 | tr -d '\n' | bunx wrangler secret put SESSION_SECRET
   openssl rand -base64 48 | tr -d '\n' > ../../.prod-bootstrap-key.local
   chmod 600 ../../.prod-bootstrap-key.local
   cat ../../.prod-bootstrap-key.local | bunx wrangler secret put BOOTSTRAP_API_KEY
   stat -f '%OLp %N' ../../.prod-bootstrap-key.local
   bunx wrangler secret list
   ```

   On Linux, replace the `stat` command with `stat -c '%a %n' ../../.prod-bootstrap-key.local`. Expected: file mode `600`; the secret list names `SESSION_SECRET` and `BOOTSTRAP_API_KEY` without revealing values. Paste back: the mode line and secret names only.

6. **[x] Already done on `2026-09-13` — Apply production migrations.**

   ```sh
   cd /path/to/dossier/apps/web
   bunx wrangler d1 migrations apply dossier-production --remote
   ```

   Expected: every pending migration is marked applied, or Wrangler reports that there is nothing to apply. Paste back: migration names and statuses.

7. **[x] Already done on `2026-09-13` — Build and deploy production.**

   ```sh
   cd /path/to/dossier/apps/web
   bunx vite build
   bunx wrangler deploy
   ```

   Expected: the Vite build succeeds; Wrangler uploads Worker and static assets, reports the `dossier.agent964.com` custom domain, and exits zero. Paste back: deployed version ID, domain, and exit status.

   Done: first deploy `d6ca0b1c-c7d2-4239-95e1-f6d110a49c75`; final phase-4 deploy `256cba25-6889-4c85-9f5a-766e449f355c`, custom domain `dossier.agent964.com`, health 200.

8. **[x] Already done on `2026-09-13` — Run the protected setup endpoint.**

   The script reapplies migrations intentionally, then calls `POST /api/setup` without exposing the key in the curl process arguments.

   ```sh
   cd /path/to/dossier
   apps/web/scripts/setup.sh \
     --env production \
     --key-file .prod-bootstrap-key.local
   ```

   Expected JSON:

   ```json
   {"ok":true,"workspaceId":"workspace_agent964","workspaceSlug":"agent964","bootstrapAccountId":"acct_bootstrap","bootstrapApiKeyId":"key_bootstrap"}
   ```

   A rerun must return the same summary without creating duplicates. Paste back: the JSON summary, never the key.

9. **[x] Already done on `2026-09-13` — Verify health.**

   ```sh
   curl --fail-with-body --silent --show-error \
     https://dossier.agent964.com/api/healthz
   printf '\n'
   ```

   Expected: HTTP 200 and JSON containing `{"ok":true,"service":"dossier"}`. Paste back: status and JSON.

10. **[x] Already done on `2026-09-13` — Verify an authenticated tree page, then archive the probe.**

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

    Expected: a 12-character document ID, `Tree HTTP 200`, the probe title in the HTML, then archive JSON with `"ok":true`. Paste back: those four items; redact headers and tokens. The probe remains recoverable in trash by design.

## B. Owner handoff

Only the owner performs these steps, in this order. Every CLI command below pins the production origin and clears inherited Dossier environment credentials, so an existing development configuration cannot receive the production key or later commands.

1. **Publish the CLI package.**

   ```sh
   cd /path/to/dossier/packages/cli
   npm login
   bun run release
   npm view @agent964/dossier version
   ```

   `npm login` opens npm's browser confirmation. Expected: `bun run release` completes and `npm view` prints the released version. Paste back: the package version and release URL; never npm credentials or one-time codes.

2. **Install that exact release.**

   ```sh
   npm install --global @agent964/dossier@<version>
   dossier --version
   ```

   Expected: `dossier --version` prints `<version>`. Paste back: that line.

3. **Complete the first production sign-in.**

   Open <https://dossier.agent964.com>, choose **Sign in**, then **Continue with shoo**. Sign in as `malhashemi@agent964.com`. Shoo opens at `shoo.dev`; its one-time consent screen identifies `https://dossier.agent964.com` and asks to share the verified email plus basic profile (name and picture). Approve it once.

   Expected: the browser returns to the dossier dashboard and shows workspace `agent964` with role `admin`. Paste back: the final URL and that workspace/role text, not cookies or identity tokens.

4. **Mint and store the owner's CLI key.**

   Open <https://dossier.agent964.com/cli/auth>. Enter a machine-specific **Key name**, choose **Generate key**, and copy the `ds_…` token from the **Shown once** panel.

   ```sh
   pbpaste | env -u DOSSIER_API_KEY -u DOSSIER_API_URL dossier --api-url https://dossier.agent964.com auth set
   env -u DOSSIER_API_KEY -u DOSSIER_API_URL dossier --api-url https://dossier.agent964.com whoami
   ```

   The command reads the key currently copied to the macOS clipboard without putting it in shell history. On Linux, use the clipboard tool available on that machine (for example, `xclip -selection clipboard -o | env -u DOSSIER_API_KEY -u DOSSIER_API_URL dossier --api-url https://dossier.agent964.com auth set`). Expected: `auth set` confirms storage and `whoami` prints the owner's account, workspace `agent964`, and role `admin`. Paste back: the `whoami` output with account ID/key ID redacted if sharing outside the team. Never paste the token.

5. **Import the existing playground.**

   ```sh
   test -f ~/model-routing-research-playground.html
   env -u DOSSIER_API_KEY -u DOSSIER_API_URL dossier --api-url https://dossier.agent964.com upload ~/model-routing-research-playground.html --kind playground
   ```

   Expected: `Created`, a permanent production `URL`, `Raw`, `Hub`, a 12-character `ID`, and `Version: 1`. Open the printed URL and confirm the playground renders and responds. Paste back: URL, Hub URL, ID, version, and render result.

6. **Allow outside email addresses when needed.**

   The `agent964.com` domain is already seeded. For a person outside it:

   ```sh
   env -u DOSSIER_API_KEY -u DOSSIER_API_URL dossier --api-url https://dossier.agent964.com workspace allow name@example.com --role member
   env -u DOSSIER_API_KEY -u DOSSIER_API_URL dossier --api-url https://dossier.agent964.com workspace
   ```

   Expected: the allowlist includes `name@example.com` as `member`. Paste back: that allowlist line. The person still needs to sign in once before appearing as a member.

7. **Retire the Postplan drafts after production is confirmed.**

   Open <https://postplan.dev>, verify the dossier import first, then optionally delete drafts `39af2hybmt7p` and `v90efjnmq5va`.

   Expected: both legacy draft URLs are removed only after the dossier URL is known-good. Paste back: each retired ID and the retained dossier URL. This step is intentionally optional and irreversible on Postplan.

## C. Day-2 operations

1. **Rotate the production bootstrap key.**

   This rotates both the setup-endpoint secret and the hashed `acct_bootstrap` API credential. It explicitly re-enables `key_bootstrap`; `dossier setup` never auto-unrevokes it.

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

   Expected: secret update succeeds, D1 reports one changed row, and setup returns `"ok":true`. Paste back: statuses and setup JSON only.

2. **Add an allowlist entry.**

   ```sh
   env -u DOSSIER_API_KEY -u DOSSIER_API_URL dossier --api-url https://dossier.agent964.com workspace allow name@example.com --role member
   env -u DOSSIER_API_KEY -u DOSSIER_API_URL dossier --api-url https://dossier.agent964.com workspace
   ```

   Expected: the allowlist shows the normalized email and role `member`. For a whole domain, use `@example.com`. Paste back: the added line.

3. **Restore a document subtree from trash.**

   ```sh
   dossier trash
   dossier restore <document-id> --batch <batch-id>
   dossier tree <document-id>
   ```

   Copy the root document ID and batch ID from `dossier trash`. Expected: `Restored`, followed by a readable tree. Paste back: document ID, batch ID, and restore/tree output.

4. **Roll back a production deploy.**

   ```sh
   cd /path/to/dossier/apps/web
   bunx wrangler versions list
   bunx wrangler rollback <known-good-version-id> \
     --message "Rollback: <incident or reason>" --yes
   curl --fail-with-body --silent --show-error \
     https://dossier.agent964.com/api/healthz
   printf '\n'
   ```

   Expected: Wrangler confirms the selected version is active and health returns `"ok":true`. Paste back: old/new version IDs, reason, and health JSON. A code rollback does not roll back D1 migrations; restore database data separately if the incident requires it.

5. **Read production logs.**

   ```sh
   cd /path/to/dossier/apps/web
   bunx wrangler tail dossier --format pretty
   ```

   Expected: live request and exception events from the production Worker. Reproduce one request, capture only relevant lines, then stop with `Ctrl-C`. Paste back: timestamp, request path, status, and exception text with secrets, cookies, emails, and Bearer headers redacted.
