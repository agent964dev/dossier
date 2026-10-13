// The comments component's sheet. Every rule sits inside :where(), in the
// base layer, so any page or kit rule wins. It reads the tree's theme
// variables when set and otherwise inherits the page's fonts and colours,
// with tints mixed from currentColor. Only logical properties, so a
// right-to-left page mirrors it; pin markers are placed from JavaScript.

const BORDER =
  'var(--border, color-mix(in srgb, currentColor 22%, transparent))'
const TINT = 'color-mix(in srgb, currentColor 10%, transparent)'

export const STYLES = `
:where(dossier-comments) { display: block; }
:where(dossier-comments [hidden]) { display: none !important; }
:where(.dossier-comments) {
  font: inherit; color: inherit; margin-block: 1.5em; overflow-wrap: anywhere;
}
:where(.dossier-comments :focus-visible) {
  outline: 2px solid var(--ring, currentColor); outline-offset: 2px;
}
:where(.dossier-comments-hidden) {
  position: absolute; inline-size: 1px; block-size: 1px; margin: -1px;
  padding: 0; border: 0; overflow: hidden; clip-path: inset(50%);
  white-space: nowrap;
}
:where(.dossier-comments-header) {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.5em 0.75em;
  margin-block-end: 0.5em;
}
:where(.dossier-comments-title) { margin: 0; font-size: 1.25em; }
:where(.dossier-comments-count) { color: var(--muted-foreground, inherit); }
:where(.dossier-comments-button) {
  font: inherit; font-size: 0.875em; color: inherit; background: transparent;
  border: 1px solid ${BORDER}; border-radius: var(--radius, 0.375rem);
  padding-block: 0.25em; padding-inline: 0.625em;
  min-block-size: 1.75rem; min-inline-size: 1.75rem; cursor: pointer;
}
:where(.dossier-comments-button:hover) { background: ${TINT}; }
:where(.dossier-comments-button[aria-pressed="true"]) { background: ${TINT}; }
:where(.dossier-comments-button[aria-disabled="true"]) { cursor: progress; }
:where(.dossier-comments-primary) {
  color: var(--primary-foreground, inherit); background: var(--primary, transparent);
  border-color: var(--primary, currentColor); font-weight: 600;
  min-block-size: 2.75rem; padding-inline: 1.25em;
}
:where(.dossier-comments-primary:hover) {
  background: var(--primary, ${TINT});
}
:where(.dossier-comments-link) { color: inherit; text-decoration: underline; }
:where(.dossier-comments-threads, .dossier-comments-replies) {
  list-style: none; margin: 0; padding: 0;
}
:where(.dossier-comments-thread) {
  padding-block: 0.875em; border-block-start: 1px solid ${BORDER};
}
:where(.dossier-comments-thread:focus) { outline-offset: 4px; }
:where(.dossier-comments-place) {
  margin-block: 0 0.5em; font-size: 0.875em;
  color: var(--muted-foreground, inherit);
  display: flex; flex-wrap: wrap; gap: 0.25em 0.5em; align-items: baseline;
}
:where(.dossier-comments-comment) {
  display: grid; grid-template-columns: auto minmax(0, 1fr);
  column-gap: 0.625em; align-items: start;
}
:where(.dossier-comments-avatar) {
  display: inline-grid; place-items: center; box-sizing: border-box;
  inline-size: 2rem; block-size: 2rem; border-radius: 50%;
  background: ${TINT}; font-weight: 600; font-size: 0.875em;
  text-transform: uppercase; line-height: 1;
}
:where(.dossier-comments-main) { min-inline-size: 0; display: grid; gap: 0.25em; }
:where(.dossier-comments-meta) {
  margin: 0; display: flex; flex-wrap: wrap; align-items: baseline;
  gap: 0.125em 0.5em; font-size: 0.875em;
  color: var(--muted-foreground, inherit);
}
:where(.dossier-comments-author) { font-weight: 600; color: inherit; }
:where(.dossier-comments-agent) {
  font-size: 0.75em; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; border: 1px solid ${BORDER};
  border-radius: 0.375em; padding-inline: 0.375em;
}
:where(.dossier-comments-stance) {
  font-size: 0.875em; border: 1px solid ${BORDER}; border-radius: 999px;
  padding-block: 0; padding-inline: 0.5em;
}
:where(.dossier-comments-text) { margin: 0; white-space: pre-wrap; }
:where(.dossier-comments-mention) {
  font-weight: 600; border-radius: 0.375em;
  padding-block: 0.0625em; padding-inline: 0.25em;
  background: color-mix(in srgb, var(--primary, currentColor) 16%, transparent);
  -webkit-box-decoration-break: clone; box-decoration-break: clone;
}
:where(.dossier-comments-mention-me) {
  background: color-mix(in srgb, var(--primary, currentColor) 30%, transparent);
  box-shadow: inset 0 0 0 1px var(--primary, currentColor);
}
:where(.dossier-comments-comment[data-highlight]) {
  border-radius: var(--radius, 0.375rem);
  background: color-mix(in srgb, var(--primary, currentColor) 12%, transparent);
  outline: 2px solid var(--ring, currentColor); outline-offset: 0.375em;
}
:where(.dossier-comments-deleted) {
  margin: 0; font-style: italic; color: var(--muted-foreground, inherit);
}
:where(.dossier-comments-replies) {
  display: grid; gap: 0.75em; margin-block-start: 0.75em;
  padding-inline-start: 0.875em; border-inline-start: 2px solid ${BORDER};
}
:where(.dossier-comments-actions) {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.375em;
  margin-block-start: 0.375em;
}
:where(.dossier-comments-confirm) { font-size: 0.875em; margin: 0; }
:where(.dossier-comments-earlier) { margin-block-start: 1em; }
:where(.dossier-comments-earlier > summary) {
  cursor: pointer; font-weight: 600; padding-block: 0.375em;
}
:where(.dossier-comments-empty) {
  margin-block: 0.5em; color: var(--muted-foreground, inherit);
}
:where(.dossier-comments-composer) {
  display: grid; gap: 0.5em; margin-block-start: 1em;
}
:where(.dossier-comments-thread .dossier-comments-composer) {
  margin-block-start: 0.75em;
}
:where(.dossier-comments-label) { font-weight: 600; }
:where(.dossier-comments-input) {
  display: block; box-sizing: border-box; inline-size: 100%;
  min-block-size: 5.5em; resize: vertical; font: inherit; color: inherit;
  background: var(--background, transparent); border: 1px solid ${BORDER};
  border-radius: var(--radius, 0.375rem);
  padding-block: 0.5em; padding-inline: 0.625em;
}
:where(.dossier-comments-input[aria-invalid="true"]) {
  border-color: currentColor; border-width: 2px;
}
:where(.dossier-comments-options) {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.5em 0.75em;
}
:where(.dossier-comments-options:empty) { display: none; }
:where(.dossier-comments-field) {
  display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.375em;
  font-size: 0.875em; max-inline-size: 100%;
}
:where(.dossier-comments-select) {
  font: inherit; color: inherit; background: var(--background, transparent);
  border: 1px solid ${BORDER}; border-radius: var(--radius, 0.375rem);
  min-block-size: 1.75rem; max-inline-size: 100%;
  padding-block: 0.125em; padding-inline: 0.375em;
}
:where(.dossier-comments-note) {
  margin: 0; font-size: 0.875em; color: var(--muted-foreground, inherit);
}
:where(.dossier-comments-suggestions) {
  list-style: none; margin: 0; padding: 0.25em;
  max-block-size: 12em; overflow: auto;
  background: var(--card, var(--background, Canvas)); color: inherit;
  border: 1px solid ${BORDER}; border-radius: var(--radius, 0.375rem);
}
:where(.dossier-comments-suggestion) {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.125em 0.5em;
  padding-block: 0.375em; padding-inline: 0.5em; cursor: pointer;
  border-radius: calc(var(--radius, 0.375rem) - 2px);
}
:where(.dossier-comments-suggestion .dossier-comments-avatar) {
  inline-size: 1.5rem; block-size: 1.5rem; font-size: 0.75em;
  overflow: hidden; flex: none;
}
:where(.dossier-comments-avatar > img) {
  display: block; inline-size: 100%; block-size: 100%; object-fit: cover;
}
:where(.dossier-comments-suggestion-name) { font-weight: 600; }
:where(.dossier-comments-suggestion-detail) {
  font-size: 0.875em; color: var(--muted-foreground, inherit);
  overflow-wrap: anywhere;
}
:where(.dossier-comments-suggestion[aria-selected="true"]) {
  background: ${TINT}; outline: 2px solid var(--ring, currentColor);
  outline-offset: -2px;
}
:where(.dossier-comments-feedback) {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.5em;
}
:where(.dossier-comments-status) { margin: 0; font-size: 0.875em; }
:where(.dossier-comments-pins) { position: relative; block-size: 0; }
:where(.dossier-comments-pin) {
  position: absolute; z-index: 1; translate: -50% -50%;
  display: grid; place-items: center; box-sizing: border-box;
  inline-size: 1.75rem; block-size: 1.75rem; padding: 0; border-radius: 50%;
  font: inherit; font-size: 0.8125em; font-weight: 600; line-height: 1;
  color: var(--primary-foreground, Canvas); background: var(--primary, CanvasText);
  border: 2px solid var(--primary-foreground, Canvas);
  box-shadow: 0 0 0 1px color-mix(in srgb, CanvasText 45%, transparent);
  cursor: pointer;
}
:where(.dossier-comments-pin-draft) {
  color: var(--foreground, CanvasText); background: var(--background, Canvas);
  border: 2px dashed var(--foreground, CanvasText);
}
:where(span.dossier-comments-pin) { pointer-events: none; }
:where(.dossier-comments-pin-target) {
  position: absolute; z-index: 1; box-sizing: border-box; cursor: crosshair;
  outline: 2px dashed var(--ring, CanvasText); outline-offset: -2px;
  background: color-mix(in srgb, Canvas 12%, transparent);
}
:where(.dossier-comments-open) {
  display: inline-flex; align-items: baseline; gap: 0.5em;
}
:where(.dossier-comments-item) { margin-block: 0.5em; }
:where(.dossier-comments-item .dossier-comments-header) { margin-block-end: 0; }
:where(.dossier-comments-item .dossier-comments-threads) {
  margin-block-start: 0.5em;
}
:where(.dossier-comments-item .dossier-comments-thread) { padding-block: 0.625em; }
:where(.dossier-comments-item .dossier-comments-composer) {
  margin-block-start: 0.5em;
}
:where(.dossier-comments-item .dossier-comments-input) { min-block-size: 3.5em; }
@media (prefers-reduced-motion: no-preference) {
  :where(.dossier-comments-button, .dossier-comments-pin) {
    transition: background-color 120ms ease, border-color 120ms ease;
  }
  :where(.dossier-comments-comment) {
    transition: background-color 600ms ease, outline-color 600ms ease;
  }
}
`
