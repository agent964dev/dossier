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
- Production resources and the top-level env are NOT created/deployed; that is phase 4.
- Workflow shape and model seats: `docs/WORKFLOW.md`. Owner decisions: `docs/PLAN.md` section 1.

## Lessons from session 1 (bake into prompts)
- Builder prompts must be short and point at files to read; agents with big prompts plus large codebases hit "Prompt is too long" (phase 0 integrate, phase 2 core).
- Cap agent reports (~300 words) and pass only briefs between stages.
- Parallel builders own disjoint directories and never edit package.json.
- Orchestrator commits once per phase after re-running `bun run typecheck` and `bun run test` itself.
