// The kit's names: which tags are custom elements, and which files under a
// folder's `_components/` define them.

/** Hyphenated names the HTML standard keeps for SVG and MathML. */
const RESERVED_NAMES = new Set([
  'annotation-xml',
  'color-profile',
  'font-face',
  'font-face-src',
  'font-face-uri',
  'font-face-format',
  'font-face-name',
  'missing-glyph',
])
const CUSTOM_NAME =
  /^[a-z][-.0-9_a-z\u00B7\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u037D\u037F-\u1FFF\u200C-\u200D\u203F\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}]*$/u

/** A valid custom element name: lower case, a hyphen, not reserved. */
export const isCustomElementName = (name: string): boolean =>
  name.includes('-') && CUSTOM_NAME.test(name) && !RESERVED_NAMES.has(name)

/**
 * The tag a component file defines, or null: `<folder>/_components/<tag>.js`,
 * where no name in `<folder>` starts with '_'.
 */
export const tagOf = (path: string): string | null => {
  const segments = path.split('/')
  const file = segments.pop() ?? ''
  if (segments.pop() !== '_components') return null
  if (segments.some((segment) => segment.startsWith('_'))) return null
  if (!file.endsWith('.js')) return null
  const tag = file.slice(0, -'.js'.length)
  return isCustomElementName(tag) ? tag : null
}

/** `<folder>/_components/<tag>.js` with a valid tag. */
export const isComponentFile = (path: string): boolean => tagOf(path) !== null

/** The file that defines `tag` in `folder`: `guides/_components/acme-card.js`. */
export const componentPath = (folder: string, tag: string): string =>
  folder === '' ? `_components/${tag}.js` : `${folder}/_components/${tag}.js`
