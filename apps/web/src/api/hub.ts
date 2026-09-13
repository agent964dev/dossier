/**
 * The reader-facing hub page: `GET /d/:id/tree` (PLAN section 7).
 *
 * This response is produced by the Worker's serving handler, before (and
 * without) the React app, so it cannot reach the Tailwind bundle — its
 * filename is content-hashed at build time. The page therefore carries its
 * own critical CSS: the same agent964 tokens as `src/styles/tokens.css`
 * (OKLCH literals, the token each one mirrors named in a comment), the same
 * self-hosted fonts from the static assets binding, the same cyan-on-near-black
 * atmosphere. Clash Display carries the title, Geist the reading voice, Geist
 * Mono the uppercase 0.2em micro-labels that mark kind, version, and ID.
 *
 * Two rules hold everywhere in this file:
 *
 * 1. Every interpolated value goes through `escapeHtml`. Titles, kinds,
 *    descriptions, and author names are user- and agent-supplied text.
 * 2. Nothing is rendered that is not already in the `TreeResponse`. The tree
 *    service has stripped unreadable ancestors, siblings through a hidden
 *    parent, storage depths, and boundary provenance; this renderer must not
 *    reintroduce any of it, or invent copy that implies it (a document whose
 *    parent is hidden is simply shown without a breadcrumb).
 *
 * The only script is the copy-ID handler, allowed by a per-request nonce in
 * the section 7 web CSP. It reads the ID from a data attribute rather than
 * having it interpolated into JavaScript.
 */

import type { DocumentReader, TreeResponse } from '@dossier/contracts'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** 128 random bits, base64url so the value needs no escaping in CSP or HTML. */
function createNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

const MONTHS: readonly string[] = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

interface Timestamp {
  readonly label: string
  readonly machine: string
}

/**
 * Formatted on the server in UTC rather than through `Intl`, so the string is
 * identical on workerd and in tests and never depends on a locale database.
 */
function formatTimestamp(value: string): Timestamp {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return { label: value, machine: value }
  const day = String(parsed.getUTCDate()).padStart(2, '0')
  const month = MONTHS[parsed.getUTCMonth()]
  const hours = String(parsed.getUTCHours()).padStart(2, '0')
  const minutes = String(parsed.getUTCMinutes()).padStart(2, '0')
  return {
    label: `${day} ${month} ${parsed.getUTCFullYear()} · ${hours}:${minutes} UTC`,
    machine: parsed.toISOString(),
  }
}

function displayKind(kind: string | null): string {
  const trimmed = kind?.trim() ?? ''
  return trimmed === '' ? 'document' : trimmed
}

function displayVersion(versionNumber: number): string {
  return Number.isFinite(versionNumber) ? `v${Math.trunc(versionNumber)}` : 'v–'
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

interface KindGroup {
  readonly kind: string
  readonly documents: readonly DocumentReader[]
}

/**
 * Groups children by kind in first-appearance order; the tree query already
 * orders by kind, then title, then id, so the groups come out stable.
 */
function groupByKind(
  documents: readonly DocumentReader[],
): readonly KindGroup[] {
  const groups = new Map<string, DocumentReader[]>()
  for (const document of documents) {
    const kind = displayKind(document.kind)
    const bucket = groups.get(kind)
    if (bucket) bucket.push(document)
    else groups.set(kind, [document])
  }
  return [...groups].map(([kind, members]) => ({ kind, documents: members }))
}

const CHEVRON =
  '<svg class="row-arrow" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'

const MARK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.75h6l5 5V18a2.5 2.5 0 0 1-2.5 2.5H8A2.5 2.5 0 0 1 5.5 18V5.25A2.5 2.5 0 0 1 8 2.75Z"/><path d="M13.75 3v3.75a1.5 1.5 0 0 0 1.5 1.5h3.5"/><path d="M9.25 13h6" opacity="0.55"/><path d="M9.25 16.25h3.5" opacity="0.55"/></svg>'

/**
 * A navigable row. Children carry their kind in the group label above them, so
 * only siblings repeat it inline; both always name their author.
 */
function renderRow(document: DocumentReader, showKind: boolean): string {
  const meta = [
    ...(showKind ? [escapeHtml(displayKind(document.kind))] : []),
    escapeHtml(document.authorName),
    `<span class="tabular">${escapeHtml(displayVersion(document.latestVersionNumber))}</span>`,
  ].join('<span class="sep">·</span>')
  return `<li><a class="row" href="${escapeHtml(document.hubUrl)}"><span class="row-main"><span class="row-title">${escapeHtml(document.title)}</span><span class="micro row-meta">${meta}</span></span>${CHEVRON}</a></li>`
}

function renderSection(label: string, count: number, content: string): string {
  return `<section class="section"><div class="section-head"><h2 class="micro">${escapeHtml(label)}</h2><span class="micro count tabular">${escapeHtml(plural(count, 'document'))}</span></div>${content}</section>`
}

const COPY_SCRIPT =
  '(function(){var b=document.querySelector("[data-copy]");var i=document.querySelector("[data-copy-source]");if(!b)return;var l=b.querySelector("[data-copy-label]")||b;var o=l.textContent;var t;function done(){l.textContent="Copied";b.setAttribute("data-copied","true");if(i)i.classList.remove("manual");clearTimeout(t);t=setTimeout(function(){l.textContent=o;b.removeAttribute("data-copied")},1800)}function fallback(v){if(!i)return;i.value=v;i.focus();i.select();var ok=false;try{ok=document.execCommand("copy")}catch(e){}if(ok){b.focus();done();return}i.classList.add("manual");i.focus();i.select();l.textContent="ID selected";b.setAttribute("data-copied","false")}b.addEventListener("click",function(){var v=b.getAttribute("data-copy")||"";if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(v).then(done,function(){fallback(v)})}else{fallback(v)}})})();'

const STYLE = `
:root {
  color-scheme: dark;
  --canvas: oklch(16.90% 0.0286 232.6);      /* neutral-950 */
  --card: oklch(19.26% 0.0253 234.3);        /* neutral-900 */
  --surface: oklch(24.60% 0.0276 232.1);     /* neutral-800 */
  --line: oklch(33.20% 0.0303 228.6 / 40%);  /* neutral-700 @ 40% */
  --ink: oklch(99.24% 0.0000 0.0);           /* neutral-50  */
  --ink-soft: oklch(85.16% 0.0167 206.3);    /* neutral-300 */
  --ink-label: oklch(73.96% 0.0245 212.6);   /* neutral-400 */
  --ink-muted: oklch(59.57% 0.0297 218.6);   /* neutral-500 */
  --brand: oklch(86.54% 0.1367 207.1);       /* brand-300 — the one primary */
  --brand-soft: oklch(90.85% 0.0553 207.1);  /* brand-200 */
  --complement: oklch(73.83% 0.1585 60.4);   /* complement-400 — secondary accent */
  --success: oklch(73.83% 0.2859 145.8);     /* success-400 */
  --warn: oklch(73.83% 0.1598 83.5);         /* warning-400 */
  --radius: 0.625rem;
  --ease: cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
@font-face {
  font-family: "Clash Display";
  src: url("/fonts/ClashDisplay-Variable.woff2") format("woff2");
  font-weight: 200 700;
  font-display: swap;
}
@font-face {
  font-family: "Geist";
  src: url("/fonts/Geist-Variable.woff2") format("woff2");
  font-weight: 100 900;
  font-display: swap;
}
@font-face {
  font-family: "Geist Mono";
  src: url("/fonts/GeistMono-Variable.woff2") format("woff2");
  font-weight: 100 900;
  font-display: swap;
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--canvas);
  color: var(--ink);
  font-family: "Geist", ui-sans-serif, system-ui, sans-serif;
  font-size: 1rem;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
.atmosphere { position: fixed; inset: 0; overflow: hidden; pointer-events: none; z-index: 0; }
.atmosphere::before {
  content: "";
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, color-mix(in oklab, var(--brand) 45%, transparent), transparent);
}
.atmosphere::after {
  content: "";
  position: absolute;
  top: -24rem;
  left: 50%;
  width: min(60rem, 170vw);
  height: 32rem;
  transform: translateX(-50%);
  border-radius: 999px;
  background: color-mix(in oklab, var(--brand) 11%, transparent);
  filter: blur(130px);
}
.shell {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 48rem;
  margin: 0 auto;
  padding-inline: clamp(1rem, 4vw, 2rem);
}
main.shell {
  flex: 1;
  padding-bottom: 3rem;
  display: flex;
  flex-direction: column;
  gap: clamp(1.25rem, 4vw, 1.75rem);
}
.micro {
  font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.625rem;
  line-height: 1.5;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}
.tabular { font-variant-numeric: tabular-nums; }
.sep { margin: 0 0.5em; opacity: 0.55; }
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding-block: 1.125rem;
}
.lockup { display: inline-flex; align-items: center; gap: 0.5rem; color: inherit; text-decoration: none; }
.lockup svg {
  width: 20px;
  height: 20px;
  color: var(--brand);
  filter: drop-shadow(0 0 8px color-mix(in oklab, var(--brand) 30%, transparent));
}
.wordmark {
  font-family: "Clash Display", ui-sans-serif, sans-serif;
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: -0.015em;
}
.workspace-tag {
  color: var(--ink-label);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 0.25rem 0.5rem;
  background: color-mix(in oklab, var(--surface) 55%, transparent);
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crumbs {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem 0.5rem;
  margin: 0;
  padding: 0;
  font-size: 0.8125rem;
  color: var(--ink-muted);
}
.crumbs li { display: inline-flex; align-items: center; gap: 0.5rem; min-width: 0; }
.crumbs li + li::before {
  content: "/";
  font-family: "Geist Mono", ui-monospace, monospace;
  font-size: 0.75rem;
  color: color-mix(in oklab, var(--brand) 50%, transparent);
}
.crumbs a, .crumbs span {
  display: inline-block;
  max-width: 15rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
.crumbs a {
  color: var(--ink-soft);
  text-decoration: none;
  transition: color 160ms var(--ease);
}
.crumbs a:hover { color: var(--brand-soft); }
.crumbs a:focus-visible {
  outline: 2px solid color-mix(in oklab, var(--brand) 50%, transparent);
  outline-offset: 3px;
  border-radius: 3px;
}
.crumbs [aria-current] { color: var(--ink-label); }
.hero {
  position: relative;
  overflow: hidden;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: calc(var(--radius) + 4px);
  padding: clamp(1.125rem, 4.5vw, 1.75rem);
}
.hero::before {
  content: "";
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, color-mix(in oklab, var(--brand) 60%, transparent), transparent);
}
.badges { display: flex; flex-wrap: wrap; gap: 0.375rem; margin: 0; padding: 0; list-style: none; }
.badge {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  border: 1px solid var(--line);
  border-radius: calc(var(--radius) - 4px);
  padding: 0.25rem 0.5rem;
  color: var(--ink-label);
  background: color-mix(in oklab, var(--surface) 45%, transparent);
}
.badge .dot {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: currentColor;
  box-shadow: 0 0 8px currentColor;
}
.badge code {
  font-family: inherit;
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  text-transform: none;
  color: var(--ink-soft);
}
.badge .key { color: var(--ink-muted); }
.badge.vis-public { color: var(--success); }
.badge.vis-team { color: var(--complement); }
.badge.vis-private { color: var(--ink-label); }
.badge.flag { color: var(--warn); border-color: color-mix(in oklab, var(--warn) 45%, transparent); }
.hero h1 {
  font-family: "Clash Display", ui-sans-serif, sans-serif;
  font-size: clamp(1.75rem, 7vw, 2.5rem);
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1.1;
  margin: 0.875rem 0 0;
  text-wrap: balance;
  overflow-wrap: break-word;
}
.lead { margin: 0.75rem 0 0; color: var(--ink-soft); font-size: 0.9375rem; overflow-wrap: anywhere; }
.facts {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.75rem 1.25rem;
  margin: 1.25rem 0 0;
  padding-top: 1.125rem;
  border-top: 1px solid color-mix(in oklab, var(--line) 70%, transparent);
}
.facts > div { min-width: 0; }
.facts dt { color: var(--ink-muted); }
.facts dd { margin: 0.25rem 0 0; font-size: 0.875rem; color: var(--ink); overflow-wrap: anywhere; }
.actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
  margin-top: 1.375rem;
}
.action.primary { grid-column: 1 / -1; }
.action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  height: 40px;
  padding: 0 1rem;
  border: 1px solid transparent;
  border-radius: var(--radius);
  font-family: inherit;
  font-size: 0.875rem;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
  transition: transform 160ms var(--ease), background-color 160ms var(--ease),
    border-color 160ms var(--ease), color 160ms var(--ease);
}
.action:hover { transform: translateY(-2px); }
.action:active { transform: translateY(1px); }
.action:focus-visible {
  outline: 3px solid color-mix(in oklab, var(--brand) 50%, transparent);
  outline-offset: 2px;
}
.action.primary { background: var(--brand); color: var(--canvas); }
.action.primary:hover { background: var(--brand-soft); }
.action.secondary { background: transparent; border-color: var(--line); color: var(--ink); }
.action.secondary:hover {
  border-color: color-mix(in oklab, var(--brand) 45%, transparent);
  color: var(--brand-soft);
}
.action[data-copied="true"] {
  border-color: color-mix(in oklab, var(--success) 55%, transparent);
  color: var(--success);
}
.action[data-copied="false"] {
  border-color: color-mix(in oklab, var(--warn) 55%, transparent);
  color: var(--warn);
}
.copy-source {
  position: fixed;
  left: -100vw;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.copy-source.manual {
  position: static;
  grid-column: 1 / -1;
  width: 100%;
  height: 40px;
  padding: 0 0.75rem;
  border: 1px solid color-mix(in oklab, var(--warn) 55%, transparent);
  border-radius: var(--radius);
  background: var(--canvas);
  color: var(--ink);
  font-family: "Geist Mono", ui-monospace, monospace;
  font-size: 0.8125rem;
  opacity: 1;
  pointer-events: auto;
}
.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding-bottom: 0.625rem;
  border-bottom: 1px solid color-mix(in oklab, var(--line) 70%, transparent);
}
.section-head h2 { margin: 0; font-weight: 500; color: var(--ink-label); }
.count { color: var(--ink-label); }
.group { margin-top: 1.125rem; }
.group-label {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  margin: 0 0 0.625rem;
  color: var(--complement);
}
.group-label::after {
  content: "";
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, color-mix(in oklab, var(--complement) 30%, transparent), transparent);
}
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.rows.spaced { margin-top: 1.125rem; }
.row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 0.875rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: color-mix(in oklab, var(--card) 65%, transparent);
  color: inherit;
  text-decoration: none;
  transition: transform 160ms var(--ease), background-color 160ms var(--ease),
    border-color 160ms var(--ease);
}
.row:hover {
  transform: translateY(-2px);
  background: var(--card);
  border-color: color-mix(in oklab, var(--brand) 45%, transparent);
}
.row:active { transform: translateY(1px); }
.row:focus-visible {
  outline: 3px solid color-mix(in oklab, var(--brand) 50%, transparent);
  outline-offset: 2px;
}
.row-main { min-width: 0; display: flex; flex-direction: column; gap: 0.25rem; }
.row-title {
  font-size: 0.9375rem;
  font-weight: 500;
  line-height: 1.35;
  overflow-wrap: anywhere;
  transition: color 160ms var(--ease);
}
.row:hover .row-title { color: var(--brand-soft); }
.row-meta { color: var(--ink-label); }
.row-arrow {
  margin-left: auto;
  flex: none;
  color: var(--ink-muted);
  transition: color 160ms var(--ease), transform 160ms var(--ease);
}
.row:hover .row-arrow { color: var(--brand); transform: translateX(2px); }
.quiet-empty {
  margin: 0;
  color: var(--ink-label);
}
footer.shell {
  padding-block: 1.25rem;
  border-top: 1px solid color-mix(in oklab, var(--line) 70%, transparent);
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
  color: var(--ink-muted);
}
@media (min-width: 30rem) {
  .actions { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .action.primary { grid-column: auto; }
}
@media (min-width: 34rem) {
  .facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
`

export function renderHubPage(tree: TreeResponse): Response {
  const nonce = createNonce()
  const focus = tree.document
  const updated = formatTimestamp(focus.updatedAt)
  const childGroups = groupByKind(tree.children)

  const breadcrumb =
    tree.breadcrumb.length > 0
      ? `<nav aria-label="Breadcrumb"><ol class="crumbs">${tree.breadcrumb
          .map(
            (ancestor) =>
              `<li><a href="${escapeHtml(ancestor.hubUrl)}">${escapeHtml(ancestor.title)}</a></li>`,
          )
          .join(
            '',
          )}<li><span aria-current="page">${escapeHtml(focus.title)}</span></li></ol></nav>`
      : ''

  const childrenSection =
    childGroups.length > 0
      ? renderSection(
          'Nested under this',
          tree.children.length,
          childGroups
            .map(
              (group) =>
                `<div class="group"><p class="micro group-label">${escapeHtml(group.kind)}</p><ul class="rows">${group.documents
                  .map((child) => renderRow(child, false))
                  .join('')}</ul></div>`,
            )
            .join(''),
        )
      : tree.siblings.length > 0
        ? '<p class="micro quiet-empty">Nothing nested under this document</p>'
        : ''

  const siblingsSection =
    tree.siblings.length > 0
      ? renderSection(
          'Alongside this',
          tree.siblings.length,
          `<ul class="rows spaced">${tree.siblings
            .map((sibling) => renderRow(sibling, true))
            .join('')}</ul>`,
        )
      : ''

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#031119">
<meta name="robots" content="noindex">
<title>${escapeHtml(focus.title)} — dossier</title>
<style>${STYLE}</style>
</head>
<body>
<div class="atmosphere"></div>
<header class="shell top">
  <a class="lockup" href="/">${MARK}<span class="wordmark">dossier</span></a>
  <span class="micro workspace-tag">${escapeHtml(focus.workspaceSlug)}</span>
</header>
<main class="shell">
  ${breadcrumb}
  <article class="hero">
    <ul class="badges">
      <li class="micro badge"><span class="dot"></span>${escapeHtml(displayKind(focus.kind))}</li>
      <li class="micro badge tabular">${escapeHtml(displayVersion(focus.latestVersionNumber))}</li>
      <li class="micro badge vis-${escapeHtml(focus.effectiveVisibility)}"><span class="dot"></span>${escapeHtml(focus.effectiveVisibility)}</li>
      <li class="micro badge"><span class="key">ID</span><code>${escapeHtml(focus.id)}</code></li>
      ${focus.disabled ? '<li class="micro badge flag"><span class="dot"></span>Disabled</li>' : ''}
    </ul>
    <h1>${escapeHtml(focus.title)}</h1>
    ${focus.description ? `<p class="lead">${escapeHtml(focus.description)}</p>` : ''}
    <dl class="facts">
      <div><dt class="micro">Author</dt><dd>${escapeHtml(focus.authorName)}</dd></div>
      <div><dt class="micro">Updated</dt><dd><time datetime="${escapeHtml(updated.machine)}" class="tabular">${escapeHtml(updated.label)}</time></dd></div>
    </dl>
    <div class="actions">
      <a class="action primary" href="${escapeHtml(focus.url)}">Open document</a>
      <a class="action secondary" href="${escapeHtml(focus.rawUrl)}">Raw</a>
      <button class="action secondary" type="button" data-copy="${escapeHtml(focus.id)}"><span data-copy-label aria-live="polite">Copy ID</span></button>
      <input class="copy-source" data-copy-source value="${escapeHtml(focus.id)}" readonly aria-label="Document ID for manual copy">
    </div>
  </article>
  ${childrenSection}
  ${siblingsSection}
</main>
<footer class="shell">
  <span class="micro">dossier</span>
  <span class="micro">Reader view</span>
</footer>
<script nonce="${nonce}">${COPY_SCRIPT}</script>
</body>
</html>
`

  return new Response(html, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src https: data:; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'`,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  })
}
