import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  PolicyResult,
  validateCss,
  validateHtml,
  validateHtmlStatic,
  type HtmlPolicyOptions,
} from './index'

const VALID_SHA384 = `sha384-${'A'.repeat(64)}`

const OPTIONS: HtmlPolicyOptions = {
  maxBytes: 1024 * 1024,
  styleHostAllowlist: [],
  embedHostAllowlist: [],
  scriptHostAllowlist: [],
  publicOrigin: 'https://dossier.agent964.com',
}

function html(body: string, head = '<title>Policy fixture</title>'): string {
  return `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`
}

describe('validateHtml', () => {
  it('accepts safe HTML and returns reusable, schema-valid metadata', () => {
    const result = validateHtml(
      html(`
        <script>document.body.dataset.ready = 'yes'</script>
        <img src="https://z.example/image.png">
        <img src="https://a.example/image.png">
        <img src="https://z.example/again.png">
      `),
      OPTIONS,
    )

    expect(result).toEqual({
      ok: true,
      errors: [],
      warnings: [],
      title: 'Policy fixture',
      stats: {
        hasInlineScript: true,
        externalImageHosts: ['a.example', 'z.example'],
        stylesheetRefs: [],
        embedHosts: [],
      },
    })
    expect(() => Schema.decodeUnknownSync(PolicyResult)(result)).not.toThrow()
  })

  it('keeps upstream errors for empty documents and blocked tags', () => {
    expect(validateHtml('   ', OPTIONS).errors).toEqual([
      'HTML document is empty.',
    ])

    for (const tagName of ['form', 'object', 'embed', 'applet', 'base']) {
      const result = validateHtml(html(`<${tagName}></${tagName}>`), OPTIONS)
      expect(result.errors).toContain(`Blocked <${tagName}> tag found.`)
    }
  })

  it('counts UTF-8 bytes with TextEncoder, including the BOM', () => {
    const fixture = `﻿${html('<p>é</p>')}`
    const bytes = new TextEncoder().encode(fixture).byteLength

    expect(validateHtml(fixture, { ...OPTIONS, maxBytes: bytes }).ok).toBe(true)
    expect(validateHtml(fixture, { ...OPTIONS, maxBytes: bytes - 1 })).toEqual({
      ok: false,
      errors: [
        `HTML document is ${bytes} bytes; maximum is ${bytes - 1} bytes.`,
      ],
      warnings: [],
      title: null,
      stats: {
        hasInlineScript: false,
        externalImageHosts: [],
        stylesheetRefs: [],
        embedHosts: [],
      },
    })
  })

  it('rejects lone high and low surrogates without rejecting a valid pair', () => {
    expect(validateHtml(html('\uD800'), OPTIONS).errors).toContain(
      'HTML document contains a lone surrogate code unit.',
    )
    expect(validateHtml(html('\uDC00'), OPTIONS).errors).toContain(
      'HTML document contains a lone surrogate code unit.',
    )
    expect(validateHtml('<title>ok</title>\uD800', OPTIONS).errors).toContain(
      'HTML document contains a lone surrogate code unit.',
    )
    expect(validateHtmlStatic('<title>ok</title>\uD800').errors).toContain(
      'HTML document contains a lone surrogate code unit.',
    )
    expect(validateHtml(html('😀'), OPTIONS).ok).toBe(true)
  })

  it('rejects event handlers, srcdoc, normalized unsafe URLs, and meta refresh', () => {
    const result = validateHtml(
      html(`
        <a onclick="go()" href="java&#x0a;script:go()">bad link</a>
        <iframe src="/d/abcdefghijkl" srcdoc="<p>replacement</p>"></iframe>
        <meta http-equiv="refresh" content="0; https://example.com">
      `),
      OPTIONS,
    )

    expect(result.errors).toEqual(
      expect.arrayContaining([
        'Blocked inline event handler attribute "onclick" found.',
        'Blocked unsafe URL in "href" attribute.',
        'Blocked "srcdoc" attribute found.',
        'Blocked meta refresh tag found.',
      ]),
    )
  })

  it('checks blocked content inside template and both noscript parse modes', () => {
    const result = validateHtml(
      html(
        '<template><form></form></template><noscript><object></object></noscript>',
      ),
      OPTIONS,
    )

    expect(result.errors).toEqual(
      expect.arrayContaining([
        'Blocked <form> tag found.',
        'Blocked <object> tag found.',
      ]),
    )

    const parserDifferential =
      '<noscript><p title="</noscript><form><input name=secret></form><img src=x onerror=alert(1)>">'
    expect(validateHtml(parserDifferential, OPTIONS).errors).toEqual(
      expect.arrayContaining([
        'Blocked <form> tag found.',
        'Blocked inline event handler attribute "onerror" found.',
      ]),
    )

    for (const hiddenExternal of [
      '<noscript><p title="</noscript><script src=https://evil.example/x.js></script>">',
      '<noscript><p title="</noscript><link rel=stylesheet href=https://evil.example/x.css>">',
    ]) {
      expect(validateHtml(hiddenExternal, OPTIONS).ok).toBe(false)
    }
  })

  it('rejects nesting deeper than 512 element levels', () => {
    const nested = `${'<div>'.repeat(513)}content${'</div>'.repeat(513)}`
    expect(validateHtml(html(nested), OPTIONS).errors).toContain(
      'HTML is nested more than 512 levels deep.',
    )
  })

  it('allows workspace stylesheet paths and records their references', () => {
    const result = validateHtml(
      html(
        '',
        '<title>Styles</title><link rel="stylesheet" href="/a/theme.css"><link rel="stylesheet" href="/a/theme@2.css">',
      ),
      OPTIONS,
    )

    expect(result.ok).toBe(true)
    expect(result.stats.stylesheetRefs).toEqual([
      '/a/theme.css',
      '/a/theme@2.css',
    ])
  })

  it('rejects a non-allowlisted external stylesheet and accepts an allowlisted one', () => {
    const fixture = html(
      '',
      '<title>Styles</title><link rel="stylesheet" href="https://evil.example/x.css">',
    )

    expect(validateHtml(fixture, OPTIONS).errors).toContain(
      'Blocked stylesheet <link href="https://evil.example/x.css">; host is not in STYLE_HOST_ALLOWLIST.',
    )
    expect(
      validateHtml(fixture, {
        ...OPTIONS,
        styleHostAllowlist: ['evil.example'],
      }).ok,
    ).toBe(true)
  })

  it('explains why rejected stylesheet links are blocked', () => {
    expect(
      validateHtml(
        html(
          '',
          '<title>Preload</title><link rel="preload" href="/a/theme.css">',
        ),
        OPTIONS,
      ).errors,
    ).toContain(
      'Blocked <link rel="preload">; only rel="stylesheet" is allowed.',
    )
    expect(
      validateHtml(
        html(
          '',
          '<title>Path</title><link rel="stylesheet" href="/assets/theme.css">',
        ),
        OPTIONS,
      ).errors,
    ).toContain(
      'Blocked stylesheet <link href="/assets/theme.css">; first-party stylesheets must be /a/<slug>.css or /a/<slug>@<n>.css.',
    )
  })

  it('allows same-origin document iframes and gates external iframe hosts', () => {
    expect(
      validateHtml(html('<iframe src="/d/abcdefghijkl"></iframe>'), OPTIONS).ok,
    ).toBe(true)

    const youtube = html(
      '<iframe src="https://youtube.com/embed/abc"></iframe>',
    )
    expect(validateHtml(youtube, OPTIONS).errors).toContain(
      'Blocked <iframe> tag with a disallowed source.',
    )

    const allowed = validateHtml(youtube, {
      ...OPTIONS,
      embedHostAllowlist: ['youtube.com'],
    })
    expect(allowed.ok).toBe(true)
    expect(allowed.stats.embedHosts).toEqual(['youtube.com'])
  })

  it('requires allowlisting and usable integrity for external classic scripts', () => {
    const fixture = html(
      `<script src="https://cdn.example/app.js" integrity="${VALID_SHA384}"></script>`,
    )

    expect(validateHtml(fixture, OPTIONS).errors).toContain(
      'External script source is not allowlisted.',
    )
    expect(
      validateHtml(fixture, {
        ...OPTIONS,
        scriptHostAllowlist: ['cdn.example'],
      }).ok,
    ).toBe(true)

    const missingIntegrity = validateHtml(
      html('<script src="https://cdn.example/app.js"></script>'),
      { ...OPTIONS, scriptHostAllowlist: ['cdn.example'] },
    )
    expect(missingIntegrity.errors).toContain(
      'External script sources require an integrity attribute.',
    )

    for (const integrity of [
      'not-a-hash',
      'md5-ZXhhbXBsZQ==',
      'sha384-example',
    ]) {
      const malformed = validateHtml(
        html(
          `<script src="https://cdn.example/app.js" integrity="${integrity}"></script>`,
        ),
        { ...OPTIONS, scriptHostAllowlist: ['cdn.example'] },
      )
      expect(malformed.errors).toContain(
        'External script sources require valid SHA-256, SHA-384, or SHA-512 integrity metadata.',
      )
    }
  })

  it('rejects SVG script href and xlink:href sources', () => {
    for (const source of [
      'href="https://evil.example/x.js"',
      'xlink:href="https://evil.example/x.js"',
    ]) {
      const result = validateHtml(
        html(
          `<svg xmlns:xlink="http://www.w3.org/1999/xlink"><script ${source}></script></svg>`,
        ),
        OPTIONS,
      )
      expect(result.errors).toContain(
        'Externally sourced SVG scripts are not allowed.',
      )
      expect(result.stats.hasInlineScript).toBe(false)
    }
  })

  it('rejects non-classic script types while allowing inline classic scripts', () => {
    expect(
      validateHtml(html('<script type="module">export {}</script>'), OPTIONS)
        .errors,
    ).toContain('Unsupported script type "module" found.')
    expect(
      validateHtml(
        html('<script type="text/javascript">void 0</script>'),
        OPTIONS,
      ).ok,
    ).toBe(true)
  })

  it('runs only static rules when server allowlists and limits are unavailable', () => {
    const configurable = html(
      `<iframe src="https://embed.example/item"></iframe><script src="https://cdn.example/app.js" integrity="${VALID_SHA384}"></script>`,
      '<title>Configurable</title><link rel="stylesheet" href="https://styles.example/theme.css">',
    )

    expect(validateHtml(configurable, OPTIONS).ok).toBe(false)
    expect(validateHtmlStatic(configurable).ok).toBe(true)
    expect(validateHtmlStatic(html('<form></form>')).errors).toContain(
      'Blocked <form> tag found.',
    )
    expect(
      validateHtmlStatic(
        html(
          '<style>.x { background: url("http://images.example/x") }</style>',
        ),
      ).ok,
    ).toBe(false)
  })

  it('applies CSS validation to style tags and style attributes', () => {
    const styleTag = validateHtml(
      html(
        '<style>.x { background: url("https://evil.example/pixel") }</style>',
      ),
      OPTIONS,
    )
    expect(styleTag.errors).toContain('Blocked unsafe CSS in <style> tag.')

    const styleAttribute = validateHtml(
      html('<div style="width: expression(alert(1))"></div>'),
      OPTIONS,
    )
    expect(styleAttribute.errors).toContain('Blocked unsafe inline CSS.')
  })

  it('rejects nested image-set var() fallback strings in style tags and attributes', () => {
    const fallback =
      'image-set(var(--missing, &quot;https://blocked.invalid/x.png&quot;) 1x)'
    expect(
      validateHtml(
        html(
          `<style>.x { background: ${fallback.replaceAll('&quot;', '"')} }</style>`,
        ),
        OPTIONS,
      ).errors,
    ).toContain('Blocked unsafe CSS in <style> tag.')
    expect(
      validateHtml(html(`<div style="background: ${fallback}"></div>`), OPTIONS)
        .errors,
    ).toContain('Blocked unsafe inline CSS.')
  })
})

describe('validateCss', () => {
  const adversarialFixtures = [
    '@import "https://evil.example/x.css";',
    '.x { background-image: image-set("https://evil.example/pixel" 1x) }',
    String.raw`.x { background-image: u\72l("https://evil.example/pixel") }`,
    ':root { --u: "https://evil.example/pixel" } .x { background-image: image-set(var(--u) 1x) }',
    '.x { background: image-set(var(--missing, "https://blocked.invalid/x.png") 1x) }',
    '.x { background: -webkit-image-set(var(--missing, "https://blocked.invalid/x.png") 1x) }',
    String.raw`.x { background: \69mage-set(var(--missing, "https://blocked.invalid/x.png") 1x) }`,
  ]

  it.each(adversarialFixtures)(
    'rejects adversarial destination fixture %#',
    (fixture) => {
      expect(validateCss(fixture, OPTIONS).ok).toBe(false)
    },
  )

  it('allows /a destinations and HTTPS destinations on the style host allowlist', () => {
    expect(
      validateCss(
        '@import "/a/theme.css"; .x { background: url("/a/pixel.png") }',
        OPTIONS,
      ).ok,
    ).toBe(true)

    expect(
      validateCss(
        '.x { background: url("https://images.example/pixel.png") }',
        {
          ...OPTIONS,
          styleHostAllowlist: ['images.example'],
        },
      ).ok,
    ).toBe(true)
  })

  it('rejects expression(), behavior:, javascript URLs, and suspicious Raw recovery nodes', () => {
    expect(
      validateCss('.x { width: expression(alert(1)) }', OPTIONS).errors,
    ).toContain('Blocked unsafe CSS expression().')
    expect(
      validateCss(String.raw`.x { beh\61vior: url("/a/x.htc") }`, OPTIONS)
        .errors,
    ).toContain('Blocked unsafe CSS behavior property.')
    expect(
      validateCss('.x { background: url("javascript:alert(1)") }', OPTIONS)
        .errors,
    ).toContain('Blocked unsafe CSS URL.')
    expect(
      validateCss('.x { background: url(javascript:alert(1)) }', OPTIONS)
        .errors,
    ).toContain('CSS contains an unparsed URL or @import.')
  })

  it('rejects browser-normalized backslash URLs in custom-property image candidates', () => {
    const fixture = String.raw`:root { --image: "\\\\evil.invalid/review-pixel" } .x { background-image: image-set(var(--image) 1x) }`
    expect(
      validateCss(fixture, OPTIONS).errors.some((error) =>
        error.includes('CSS custom-property URL destination is not allowed.'),
      ),
    ).toBe(true)
  })

  it('does not scan comments or quoted content as executable CSS', () => {
    expect(
      validateCss('/* Use url (value) syntax. */ body { color: red }', OPTIONS)
        .ok,
    ).toBe(true)
    expect(
      validateCss('.a::after { content: "Use url (value) syntax" }', OPTIONS)
        .ok,
    ).toBe(true)
  })

  it('does not allow an allowlisted host over HTTP', () => {
    expect(
      validateCss('.x { background: url("http://images.example/pixel.png") }', {
        ...OPTIONS,
        styleHostAllowlist: ['images.example'],
      }).ok,
    ).toBe(false)
  })
})
