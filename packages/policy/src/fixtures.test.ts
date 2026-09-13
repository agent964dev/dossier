import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  validateCss,
  validateHtml,
  type CssPolicyOptions,
  type HtmlPolicyOptions,
} from './index'

const MAX_ASSET_BYTES = 5 * 1024 * 1024

const CSS_OPTIONS: CssPolicyOptions = {
  publicOrigin: 'https://dossier.agent964.com',
  styleHostAllowlist: [],
}

const HTML_OPTIONS: HtmlPolicyOptions = {
  ...CSS_OPTIONS,
  maxBytes: 1024 * 1024,
  embedHostAllowlist: [],
  scriptHostAllowlist: [],
}

function fixture(path: string): string {
  return readFileSync(
    new URL(`../test/fixtures/${path}`, import.meta.url),
    'utf8',
  )
}

interface CssFixture {
  name: string
  path: string
  options?: Partial<CssPolicyOptions>
  error?: string
}

const REJECTED_CSS_FIXTURES: CssFixture[] = [
  {
    name: 'expression()',
    path: 'css/rejected/expression.css',
    error: 'Blocked unsafe CSS expression().',
  },
  {
    name: 'behavior property',
    path: 'css/rejected/behavior.css',
    error: 'Blocked unsafe CSS behavior property.',
  },
  {
    name: '-moz-binding property',
    path: 'css/rejected/moz-binding.css',
    error: 'Blocked unsafe CSS -moz-binding property.',
  },
  {
    name: 'javascript URL',
    path: 'css/rejected/javascript-url.css',
    error: 'Blocked unsafe CSS URL.',
  },
  { name: 'hex-escaped url() name', path: 'css/rejected/escaped-url-hex.css' },
  {
    name: 'simple-escaped url() name',
    path: 'css/rejected/escaped-url-simple.css',
  },
  {
    name: 'URL in a custom property',
    path: 'css/rejected/custom-property-url.css',
  },
  {
    name: 'browser-normalized backslash URL in a custom property',
    path: 'css/rejected/custom-property-backslash-url.css',
    error: 'CSS custom-property URL destination is not allowed.',
  },
  {
    name: 'HTTP @import even when its host is allowlisted',
    path: 'css/rejected/import-http.css',
    options: { styleHostAllowlist: ['fonts.googleapis.com'] },
    error: 'CSS @import destination is not allowed.',
  },
  {
    name: 'non-allowlisted @import host',
    path: 'css/rejected/import-foreign-host.css',
    error: 'CSS @import destination is not allowed.',
  },
  {
    name: 'foreign image-set() string candidate',
    path: 'css/rejected/image-set-foreign-string.css',
    error: 'CSS image-set() destination is not allowed.',
  },
  {
    name: 'whitespace-obscured url()',
    path: 'css/rejected/url-whitespace.css',
  },
  {
    name: 'entity-spelled URL destination',
    path: 'css/rejected/url-entity.css',
  },
  {
    name: 'comment-split url() name',
    path: 'css/rejected/url-comment.css',
    error: 'CSS contains an obfuscated URL function.',
  },
  {
    name: 'Raw recovery node containing url(',
    path: 'css/rejected/raw-url.css',
    error: 'CSS contains an unparsed URL or @import.',
  },
  {
    name: 'Raw recovery node containing import',
    path: 'css/rejected/raw-import.css',
    error: 'CSS contains an unparsed URL or @import.',
  },
  // Decision: reject data: fonts. The serving CSP intentionally omits data:
  // from font-src, and workspace WOFF2 assets provide the supported path.
  {
    name: 'data: font source',
    path: 'css/rejected/data-font.css',
    error: 'CSS font destination is not allowed.',
  },
  {
    name: 'foreign @font-face source',
    path: 'css/rejected/font-face-foreign.css',
    error: 'CSS font destination is not allowed.',
  },
]

const ACCEPTED_CSS_FIXTURES: CssFixture[] = [
  { name: 'OKLCH theme variables', path: 'css/accepted/theme-oklch.css' },
  { name: 'workspace asset @import', path: 'css/accepted/asset-import.css' },
  {
    name: 'workspace WOFF2 @font-face',
    path: 'css/accepted/asset-font-face.css',
  },
  {
    name: 'allowlisted Google Fonts import',
    path: 'css/accepted/google-fonts.css',
    options: { styleHostAllowlist: ['fonts.googleapis.com'] },
  },
  {
    name: 'nested media, supports, and layer rules',
    path: 'css/accepted/nested-at-rules.css',
  },
  { name: 'CSS nesting', path: 'css/accepted/nesting.css' },
  {
    name: 'plain custom-property values',
    path: 'css/accepted/custom-properties.css',
  },
]

describe('adversarial CSS fixtures', () => {
  it.each(REJECTED_CSS_FIXTURES)(
    'rejects $name',
    ({ path, options, error }) => {
      const result = validateCss(fixture(path), { ...CSS_OPTIONS, ...options })

      expect(result.ok, `${path}: ${result.errors.join('; ')}`).toBe(false)
      if (error) {
        expect(
          result.errors.some((candidate) => candidate.includes(error)),
        ).toBe(true)
      }
    },
  )

  it.each(ACCEPTED_CSS_FIXTURES)('accepts $name', ({ path, options }) => {
    const result = validateCss(fixture(path), { ...CSS_OPTIONS, ...options })

    expect(result.ok, `${path}: ${result.errors.join('; ')}`).toBe(true)
  })

  it('marks the 5 MiB+ fixture for the server-owned asset size check', () => {
    // validateCss is intentionally content-only. The Assets service must reject
    // this fixture against MAX_ASSET_BYTES before invoking the policy package.
    const bytes = new TextEncoder().encode(
      fixture('css/rejected/oversized.css'),
    ).byteLength

    expect(bytes).toBe(MAX_ASSET_BYTES + 1)
  })
})

interface HtmlFixture {
  name: string
  path: string
  options?: Partial<HtmlPolicyOptions>
  error?: string
  stylesheetRefs?: string[]
  embedHosts?: string[]
}

const REJECTED_HTML_FIXTURES: HtmlFixture[] = [
  {
    name: 'stylesheet link to an unallowlisted host',
    path: 'html/rejected/external-stylesheet.html',
    error: 'host is not in STYLE_HOST_ALLOWLIST.',
  },
  {
    name: 'preload link',
    path: 'html/rejected/preload-link.html',
    error: 'only rel="stylesheet" is allowed.',
  },
  {
    name: 'HTML import link',
    path: 'html/rejected/import-link.html',
    error: 'only rel="stylesheet" is allowed.',
  },
  {
    name: 'icon link',
    path: 'html/rejected/icon-link.html',
    error: 'only rel="stylesheet" is allowed.',
  },
  {
    name: 'YouTube iframe with an empty embed allowlist',
    path: 'html/rejected/youtube-iframe.html',
    error: 'Blocked <iframe> tag with a disallowed source.',
  },
  {
    name: 'iframe srcdoc',
    path: 'html/rejected/iframe-srcdoc.html',
    error: 'Blocked "srcdoc" attribute found.',
  },
  {
    name: 'javascript iframe source',
    path: 'html/rejected/iframe-javascript.html',
    error: 'Blocked unsafe URL in "src" attribute.',
  },
  {
    name: 'foreign @import in a style tag',
    path: 'html/rejected/style-import.html',
    error: 'Blocked unsafe CSS in <style> tag.',
  },
  {
    name: 'javascript URL in a style attribute',
    path: 'html/rejected/inline-style-javascript.html',
    error: 'Blocked unsafe inline CSS.',
  },
  {
    name: 'entity-obscured url() in a style attribute',
    path: 'html/rejected/inline-style-entity.html',
    error: 'Blocked unsafe inline CSS.',
  },
]

const ACCEPTED_HTML_FIXTURES: HtmlFixture[] = [
  {
    name: 'workspace stylesheet link',
    path: 'html/accepted/stylesheet-link.html',
    stylesheetRefs: ['/a/theme.css'],
  },
  {
    name: 'same-origin dossier iframe',
    path: 'html/accepted/same-origin-iframe.html',
    embedHosts: [],
  },
  {
    name: 'YouTube iframe when www.youtube.com is allowlisted',
    path: 'html/accepted/youtube-iframe.html',
    options: { embedHostAllowlist: ['www.youtube.com'] },
    embedHosts: ['www.youtube.com'],
  },
]

describe('adversarial HTML fixtures', () => {
  it.each(REJECTED_HTML_FIXTURES)(
    'rejects $name',
    ({ path, options, error }) => {
      const result = validateHtml(fixture(path), {
        ...HTML_OPTIONS,
        ...options,
      })

      expect(result.ok, `${path}: ${result.errors.join('; ')}`).toBe(false)
      if (error) {
        expect(
          result.errors.some((candidate) => candidate.includes(error)),
        ).toBe(true)
      }
    },
  )

  it.each(ACCEPTED_HTML_FIXTURES)(
    'accepts $name',
    ({ path, options, stylesheetRefs, embedHosts }) => {
      const result = validateHtml(fixture(path), {
        ...HTML_OPTIONS,
        ...options,
      })

      expect(result.ok, `${path}: ${result.errors.join('; ')}`).toBe(true)
      if (stylesheetRefs)
        expect(result.stats.stylesheetRefs).toEqual(stylesheetRefs)
      if (embedHosts) expect(result.stats.embedHosts).toEqual(embedHosts)
    },
  )
})
