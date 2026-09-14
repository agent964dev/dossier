import wrapperRuntime from '../runtime/wrapper-runtime.js?raw'
import type { StateSnapshot } from '../services'

export interface WrapperPageOptions {
  readonly mode: 'account' | 'public'
  readonly snapshot: StateSnapshot
  readonly ticket: string
  readonly version: number
  readonly hasRuntime: boolean
  readonly title: string
  readonly pinned?: boolean
  readonly nonce?: string
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

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

function bootstrapJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/<\/script/gi, (closing) => `<\\/${closing.slice(2)}`)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

const MARK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.75h6l5 5V18a2.5 2.5 0 0 1-2.5 2.5H8A2.5 2.5 0 0 1 5.5 18V5.25A2.5 2.5 0 0 1 8 2.75Z"/><path d="M13.75 3v3.75a1.5 1.5 0 0 0 1.5 1.5h3.5"/><path d="M9.25 13h6" opacity="0.55"/><path d="M9.25 16.25h3.5" opacity="0.55"/></svg>'

const STYLE = `
:root {
  color-scheme: dark;
  --canvas: oklch(16.90% 0.0286 232.6);
  --card: oklch(19.26% 0.0253 234.3);
  --surface: oklch(24.60% 0.0276 232.1);
  --line: oklch(33.20% 0.0303 228.6 / 52%);
  --ink: oklch(99.24% 0 0);
  --ink-soft: oklch(85.16% 0.0167 206.3);
  --ink-label: oklch(73.96% 0.0245 212.6);
  --ink-muted: oklch(59.57% 0.0297 218.6);
  --brand: oklch(86.54% 0.1367 207.1);
  --brand-soft: oklch(90.85% 0.0553 207.1);
  --radius: 0.625rem;
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
html { min-width: 0; background: var(--canvas); -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-width: 0;
  min-height: 100dvh;
  overflow-x: hidden;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  background: var(--canvas);
  color: var(--ink);
  font-family: "Geist", ui-sans-serif, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.chrome {
  position: relative;
  z-index: 2;
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: "identity save" "status save";
  align-items: center;
  gap: 0.125rem 0.75rem;
  padding: 0.75rem clamp(0.875rem, 3vw, 1.5rem);
  border-bottom: 1px solid var(--line);
  background: color-mix(in oklab, var(--card) 94%, transparent);
}
.chrome::before {
  content: "";
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--brand), transparent);
  opacity: 0.5;
}
.identity {
  grid-area: identity;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.625rem;
}
.mark {
  width: 1.25rem;
  height: 1.25rem;
  flex: none;
  color: var(--brand);
  filter: drop-shadow(0 0 8px color-mix(in oklab, var(--brand) 28%, transparent));
}
.mark svg { display: block; width: 100%; height: 100%; }
h1 {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--ink);
  font-family: "Clash Display", ui-sans-serif, sans-serif;
  font-size: clamp(1rem, 4vw, 1.25rem);
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.02em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status {
  grid-area: status;
  min-width: 0;
  margin: 0 0 0 1.875rem;
  overflow: hidden;
  color: var(--ink-label);
  font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  line-height: 1.4;
  letter-spacing: 0.08em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.save {
  grid-area: save;
  min-width: 4.75rem;
  height: 2.5rem;
  padding: 0 1rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--ink-muted);
  font: 600 0.875rem/1 "Geist", ui-sans-serif, system-ui, sans-serif;
}
.save:disabled { cursor: not-allowed; opacity: 0.72; }
.stage {
  position: relative;
  z-index: 1;
  min-width: 0;
  min-height: 22rem;
  overflow: hidden;
  background: var(--card);
}
.frame {
  display: block;
  width: 100%;
  height: 100%;
  min-height: inherit;
  border: 0;
  background: white;
}
.overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: grid;
  place-items: center;
  padding: 1rem;
  background:
    radial-gradient(circle at 50% 20%, color-mix(in oklab, var(--brand) 9%, transparent), transparent 42%),
    var(--canvas);
}
.overlay[hidden], .overlay-panel[hidden] { display: none; }
.overlay-panel {
  width: min(100%, 24rem);
  padding: clamp(1.125rem, 5vw, 1.5rem);
  border: 1px solid var(--line);
  border-radius: calc(var(--radius) + 0.25rem);
  background: var(--card);
  text-align: center;
}
.loader {
  width: 1.75rem;
  height: 1.75rem;
  margin: 0 auto 1rem;
  border: 2px solid color-mix(in oklab, var(--brand) 18%, transparent);
  border-top-color: var(--brand);
  border-radius: 999px;
  animation: turn 800ms linear infinite;
}
.overlay-title { margin: 0; color: var(--ink-soft); font-size: 0.9375rem; }
.retry {
  min-height: 2.5rem;
  margin-top: 1rem;
  padding: 0 1rem;
  border: 1px solid color-mix(in oklab, var(--brand) 48%, var(--line));
  border-radius: var(--radius);
  background: transparent;
  color: var(--brand-soft);
  font: 600 0.875rem/1 "Geist", ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
}
.retry:hover { background: color-mix(in oklab, var(--brand) 8%, transparent); }
.retry:focus-visible, .save:focus-visible {
  outline: 3px solid color-mix(in oklab, var(--brand) 50%, transparent);
  outline-offset: 2px;
}
@keyframes turn { to { transform: rotate(360deg); } }
@media (min-width: 40rem) {
  .chrome {
    grid-template-columns: minmax(0, 1fr) auto auto;
    grid-template-areas: "identity status save";
    min-height: 4.25rem;
  }
  .status { margin: 0; text-align: right; }
}
@media (prefers-reduced-motion: reduce) {
  .loader { animation-duration: 1.8s; }
}
`

export function renderWrapperPage(options: WrapperPageOptions): Response {
  const nonce = options.nonce ?? createNonce()
  const snapshot = options.snapshot
  const pinned = options.pinned ?? options.version !== snapshot.version
  const status = !options.hasRuntime
    ? 'Published before saved values'
    : pinned
      ? 'Older version, read only'
      : 'Read only'
  const framePath = pinned
    ? `/d/${snapshot.documentId}/v/${options.version}/frame`
    : `/d/${snapshot.documentId}/frame`
  const frameSrc = `${framePath}?t=${encodeURIComponent(options.ticket)}`
  const bootstrap = bootstrapJson({
    snapshot,
    frameTicket: options.ticket,
    frameVersion: options.version,
    frameHasRuntime: options.hasRuntime,
  })
  const overlayHidden = options.hasRuntime ? '' : ' hidden'
  const frameConcealed = options.hasRuntime ? ' inert aria-hidden="true"' : ''

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#031119">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)} — dossier</title>
<style>${STYLE}</style>
</head>
<body data-mode="${options.mode}">
<header class="chrome">
  <div class="identity">
    <span class="mark">${MARK}</span>
    <h1>${escapeHtml(options.title)}</h1>
  </div>
  <p class="status" id="dossier-status" aria-live="polite">${status}</p>
  <button class="save" id="dossier-save" type="button" disabled>Save</button>
</header>
<main class="stage">
  <iframe class="frame" id="dossier-frame" title="${escapeHtml(options.title)}" src="${escapeHtml(frameSrc)}" sandbox="allow-scripts allow-popups"${frameConcealed}></iframe>
  <div class="overlay" id="dossier-overlay"${overlayHidden}>
    <div class="overlay-panel" id="dossier-overlay-loading" role="status" aria-live="polite" aria-atomic="true">
      <div class="loader" aria-hidden="true"></div>
      <p class="overlay-title">Loading saved values…</p>
    </div>
    <div class="overlay-panel" id="dossier-overlay-error" role="alert" aria-atomic="true" hidden>
      <p class="overlay-title">Could not load the saved values</p>
      <button class="retry" id="dossier-retry" type="button">Retry</button>
    </div>
  </div>
</main>
<script type="application/json" id="dossier-bootstrap">${bootstrap}</script>
<script nonce="${nonce}">${wrapperRuntime}</script>
</body>
</html>
`

  return new Response(html, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'none'; script-src 'nonce-${nonce}'; frame-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  })
}
