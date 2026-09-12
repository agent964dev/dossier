/**
 * Server-rendered pages for the `/auth/*` handler.
 *
 * These responses are produced by the Worker's Effect handler, before the
 * React app exists for the request, so they cannot reach the Tailwind bundle
 * (its filename is content-hashed at build time). They therefore carry their
 * own critical CSS — the same agent964 tokens, the same self-hosted fonts, the
 * same cyan-on-near-black atmosphere — so a refusal or a cancelled sign-in
 * still looks like the product and not like a server error.
 *
 * Everything here is inert: no script, no form, one link per action.
 */

export type StaticPageTone = 'brand' | 'warn' | 'danger'

export interface StaticPageAction {
  readonly href: string
  readonly label: string
  readonly primary?: boolean
}

export interface StaticPageOptions {
  readonly title: string
  readonly kicker: string
  readonly heading: string
  readonly body: string
  readonly tone?: StaticPageTone
  readonly detail?: string | null
  readonly note?: string | null
  readonly actions?: readonly StaticPageAction[]
  readonly status?: number
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const TONE_COLOR: Record<StaticPageTone, string> = {
  brand: 'var(--brand)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
}

const STYLE = `
:root {
  color-scheme: dark;
  --canvas: oklch(16.90% 0.0286 232.6);
  --card: oklch(19.26% 0.0253 234.3);
  --line: oklch(33.20% 0.0303 228.6 / 40%);
  --ink: oklch(99.24% 0.0000 0.0);
  --ink-soft: oklch(73.96% 0.0245 212.6);
  --ink-muted: oklch(59.57% 0.0297 218.6);
  --brand: oklch(86.54% 0.1367 207.1);
  --brand-soft: oklch(90.85% 0.0553 207.1);
  --warn: oklch(73.83% 0.1585 60.4);
  --danger: oklch(86.54% 0.0889 27.4);
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
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100dvh;
  background: var(--canvas);
  color: var(--ink);
  font-family: "Geist", ui-sans-serif, system-ui, sans-serif;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  display: flex;
  flex-direction: column;
}
.atmosphere {
  position: fixed;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
}
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
  top: -26rem;
  left: 50%;
  width: min(64rem, 160vw);
  height: 34rem;
  transform: translateX(-50%);
  border-radius: 999px;
  background: color-mix(in oklab, var(--tone) 22%, transparent);
  filter: blur(120px);
}
main {
  position: relative;
  z-index: 1;
  flex: 1;
  width: 100%;
  max-width: 34rem;
  margin: 0 auto;
  padding: clamp(1.25rem, 4vw, 2rem);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1.5rem;
}
.lockup {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  text-decoration: none;
  color: inherit;
  width: fit-content;
}
.lockup svg {
  width: 22px;
  height: 22px;
  color: var(--brand);
  filter: drop-shadow(0 0 8px color-mix(in oklab, var(--brand) 30%, transparent));
}
.wordmark {
  font-family: "Clash Display", ui-sans-serif, sans-serif;
  font-size: 1.0625rem;
  font-weight: 600;
  letter-spacing: -0.015em;
}
.micro {
  font-family: "Geist Mono", ui-monospace, monospace;
  font-size: 10px;
  line-height: 1.5;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: clamp(1.25rem, 4vw, 1.75rem);
}
.kicker {
  color: var(--tone);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.kicker::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentColor;
  box-shadow: 0 0 10px currentColor;
}
h1 {
  font-family: "Clash Display", ui-sans-serif, sans-serif;
  font-size: clamp(1.625rem, 6vw, 2rem);
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1.1;
  margin: 0.875rem 0 0;
  text-wrap: balance;
}
p.body {
  margin: 0.875rem 0 0;
  color: var(--ink-soft);
  font-size: 0.9375rem;
}
.detail {
  margin-top: 1.125rem;
  padding: 0.6875rem 0.875rem;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: color-mix(in oklab, var(--canvas) 70%, transparent);
  color: var(--ink);
  font-family: "Geist Mono", ui-monospace, monospace;
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
}
.note {
  margin: 1.125rem 0 0;
  color: var(--ink-muted);
  font-size: 0.8125rem;
}
.actions {
  margin-top: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}
.action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 40px;
  padding: 0 1rem;
  border-radius: 10px;
  border: 1px solid transparent;
  font-size: 0.875rem;
  font-weight: 600;
  text-decoration: none;
  transition: transform 200ms var(--ease), background-color 200ms var(--ease), border-color 200ms var(--ease), color 200ms var(--ease);
}
.action:hover { transform: translateY(-2px); }
.action:active { transform: translateY(1px); }
.action:focus-visible { outline: 3px solid color-mix(in oklab, var(--brand) 50%, transparent); outline-offset: 2px; }
.action.primary { background: var(--brand); color: var(--canvas); }
.action.primary:hover { background: var(--brand-soft); }
.action.secondary { border-color: var(--line); color: var(--ink); }
.action.secondary:hover { border-color: color-mix(in oklab, var(--brand) 45%, transparent); color: var(--brand-soft); }
footer {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 34rem;
  margin: 0 auto;
  padding: 1.25rem clamp(1.25rem, 4vw, 2rem);
  border-top: 1px solid color-mix(in oklab, var(--line) 70%, transparent);
  color: var(--ink-muted);
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}
@media (min-width: 640px) {
  .actions { flex-direction: row; align-items: center; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
`

const MARK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.75h6l5 5V18a2.5 2.5 0 0 1-2.5 2.5H8A2.5 2.5 0 0 1 5.5 18V5.25A2.5 2.5 0 0 1 8 2.75Z"/><path d="M13.75 3v3.75a1.5 1.5 0 0 0 1.5 1.5h3.5"/><path d="M9.25 13h6" opacity="0.55"/><path d="M9.25 16.25h3.5" opacity="0.55"/></svg>`

export function renderStaticPage(options: StaticPageOptions): Response {
  const tone = options.tone ?? 'brand'
  const actions = options.actions ?? [
    { href: '/', label: 'Back to dossier', primary: true },
  ]

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
<body style="--tone: ${TONE_COLOR[tone]}">
<div class="atmosphere"></div>
<main>
  <a class="lockup" href="/">${MARK}<span class="wordmark">dossier</span></a>
  <div class="card">
    <p class="micro kicker">${escapeHtml(options.kicker)}</p>
    <h1>${escapeHtml(options.heading)}</h1>
    <p class="body">${escapeHtml(options.body)}</p>
    ${options.detail ? `<p class="detail">${escapeHtml(options.detail)}</p>` : ''}
    ${options.note ? `<p class="note">${escapeHtml(options.note)}</p>` : ''}
    <div class="actions">
      ${actions
        .map(
          (action) =>
            `<a class="action ${action.primary ? 'primary' : 'secondary'}" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`,
        )
        .join('\n      ')}
    </div>
  </div>
</main>
<footer>
  <span class="micro">dossier</span>
  <span class="micro">Invite only</span>
</footer>
</body>
</html>
`

  return new Response(html, {
    status: options.status ?? 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    },
  })
}
