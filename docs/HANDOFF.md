# Handoff — state on 2026-09-12 (session 2 in progress)

## Committed on main
- `5be3f93` plan v4 (approved) + upstream reference
- `e0944f5` phase 0 (scaffold, stack proof, dev deploy)
- `6e22c78` phase 1 (accounts, allowlist sign-in, publication, serving, dashboard, CLI) — 143 tests, verified against env.dev

## Phase 2 — committed on main (session 2)
- tree/access/shares/archive services, API handlers for tree/patch/shares, hub `/d/:id/tree` (`apps/web/src/api/hub.ts`, nonce CSP), dashboard tree + access panel + move/archive dialogs + trash batches, CLI `tree`, `list --tree`, `move`, `visibility`, `share`, `trash`, `restore --batch`; `apps/web/test/tree-api.test.ts` covers the phase-2 acceptance list over HTTP. 169 tests. Migration 0002 applied to remote dev D1; env.dev deployed.

## Phase 3 — committed on main (session 2)
- `apps/web/src/services/assets.ts` + `apps/web/src/api/assets.ts`: POST/GET/DELETE `/api/assets`, `/a/:file` with MIME/CORS/CORP/nosniff and latest-vs-pinned cache headers; global slug reservation; `packages/policy/test/fixtures` (38 adversarial/accepted CSS+HTML fixtures); CLI `assets push|list|delete` with static CSS pre-check; `apps/web/browser/` Playwright render and embed harnesses with results JSON (Chromium 147, WebKit 26.4, both passed). 228 tests.
- Open owner decision recorded in PLAN section 15: script-driven top-level navigation from a sandboxed document.

## Phase 4 — committed on main (session 3, 2026-09-13)
- Version diff: `GET /api/documents/:id/diff` (`apps/web/src/services/diff.ts`, editor-only and live-only, html and text modes via parse5, `diff_too_large` caps, `maxEditLength` CPU bound), dashboard `/dashboard/documents/$id/diff` (side/unified/auto, text toggle, hunk navigator), CLI `dossier diff` (unified output, colour on TTY only, terminal-control escaping).
- CLI polish: global flags anywhere, precedence flag > env > config, exit codes, `auth login`, real help text, `docs/CLI.md`, final `skills/dossier/SKILL.md`; package.json is publishable (0.1.0, public, bin, files; workspace packages are devDependencies because `bun build` inlines them). Verified: `npm pack` + clean `npm install` + running the bin symlink works.
- Ops: `POST /api/setup` (constant-time bootstrap-key check), `apps/web/scripts/setup.sh`, `docs/RUNBOOK.md` (A operator, B owner, C day-2).

## Production (created 2026-09-13 by the orchestrator)
- Worker `dossier` at https://dossier.agent964.com (custom domain, `workers_dev: false`), account Agent964.
- D1 `dossier-production` id `72766ce3-44da-4bdd-a025-90a6ebe1e3e0` (EEUR), migrations 0000-0002 applied. R2 bucket `dossier-production`. Rate limiter namespace 1001.
- Secrets `SESSION_SECRET` and `BOOTSTRAP_API_KEY` set. The bootstrap key value is in `.prod-bootstrap-key.local` at the repo root (gitignored, mode 0600). Seed ran twice via the setup script; idempotent.
- Smoke (CLI against production with the bootstrap key): whoami, upload x2, fetch byte-equal, diff, `/d/:id` sandbox CSP + no-store, hub 200, dashboard diff route 307 to sign-in, delete --force. Same against env.dev.
- Not done, owner-only (PLAN 14 / RUNBOOK B): npm login + `bun run release`, first browser sign-in, mint owner key, import the playground, retire postplan drafts.

## Historical note: partial phase 2 core at start of session 2 (now merged)
`git status` shows ~23 changed files. What landed and passes:
- `apps/web/src/services/access.ts` — recursive-CTE access predicate (public/team/private/invites, node-only availability); `serving.ts`, `documents.ts` already call it
- `apps/web/src/services/tree.ts` — create-child placement guards, guarded single-statement move, kind normalisation
- `apps/web/src/services/shares.ts` — materialise-then-mutate deltas, PUT with `ifRevision`
- `apps/web/src/services/documents.ts` — multi-author subtree archive with `authors` summary, batch restore, `deletion_batches.root_title` (migration `0002_lame_daredevil.sql`)
- `packages/contracts/src/index.ts` — DocumentReader/Editor union, TreeResponse, DocumentPatch, ShareDelta/Replacement/SharesResponse, HasChildren with details, tree/patch/shares endpoints declared
- `apps/web/test/tree-access.test.ts` — 7 phase-2 acceptance tests, all passing; whole web suite 84/84; typecheck clean in all packages

Known breakage to fix first: `packages/cli` integration tests, 4 failing (`creates then updates`, `idempotency retry`, `BOM fetch`, `list cursors`) — the CLI's fake server and/or `upload`/`list` handling has not been updated for the new `DocumentView` union in contracts. Everything else green.

Not started in phase 2: API route handlers for tree/patch/shares/move (`apps/web/src/api/surfaces.ts` has no `handle('tree'…)` yet), hub page `/d/$id/tree`, dashboard tree + access panel + move/archive dialogs, CLI tree/move/visibility/share commands, dev deploy + remote acceptance, reviews.

## Environment
- Dev deploy: https://dossier-dev.tech964.workers.dev (env.dev; D1 `dossier-development`, R2 `dossier-development`); bootstrap key in `.dev-bootstrap-key.local` (gitignored, mode 0600); secrets already set.
- Production is live; see the Production section above.
- Workflow shape and model seats: `docs/WORKFLOW.md`. Owner decisions: `docs/PLAN.md` section 1.

## Lessons from session 1 (bake into prompts)
- Builder prompts must be short and point at files to read; agents with big prompts plus large codebases hit "Prompt is too long" (phase 0 integrate, phase 2 core).
- Cap agent reports (~300 words) and pass only briefs between stages.
- Parallel builders own disjoint directories and never edit package.json.
- Orchestrator commits once per phase after re-running `bun run typecheck` and `bun run test` itself.
