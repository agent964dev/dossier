import { describe, expect, test } from 'vitest'

import {
  analyze,
  base64Of,
  EXPORT_LIMIT_BYTES,
  exportRefs,
  injectedTags,
  planExport,
  type ExportAsset,
  type ExportInput,
  type ExportPiece,
  type ExportPlan,
  type ExportRef,
  type ExportTarget,
} from '../src/index.ts'
import { fixture } from './helpers.ts'

const MiB = 1024 * 1024
const LINK = 'https://dossier.example/acme/plans'

const asset = (
  name: string,
  size: number,
  type: string,
  extra: Partial<ExportAsset> = {},
): ExportAsset => ({
  sha256: name
    .replace(/[^a-z0-9]/gi, '')
    .padEnd(8, '0')
    .slice(0, 8),
  size,
  type,
  media: /^(image|video|audio)\//.test(type),
  link: `${LINK}/${name}`,
  ...extra,
})

const THEME =
  ':root { --accent: #8a1c7c }\n@font-face { font-family: Acme; src: url(fonts/acme.woff2) format("woff2") }\n'

/** What the Worker would decide for each reference of the fixture page. */
const fixtureInput = (sizes: { video?: number; hero?: number } = {}) => {
  const html = fixture('export/page.html')
  const analysis = analyze(html)
  const refs = exportRefs(html, analysis)
  const injected = injectedTags(html, analysis)!
  const font = asset('fonts/acme.woff2', 30_000, 'font/woff2')
  const targets = new Map<ExportRef, ExportTarget>()
  const byUrl: Record<string, ExportTarget> = {
    '_theme.css': {
      kind: 'sheet',
      sheet: {
        text: THEME,
        refs: [
          {
            range: {
              start: THEME.indexOf('fonts/acme.woff2'),
              end:
                THEME.indexOf('fonts/acme.woff2') + 'fonts/acme.woff2'.length,
            },
            kind: 'url',
            target: { kind: 'asset', asset: font },
          },
        ],
      },
    },
    'fonts/acme.woff2': { kind: 'drop' },
    'icon.png': { kind: 'asset', asset: asset('icon.png', 300, 'image/png') },
    'plan.md': { kind: 'link', href: `${LINK}/plan.md` },
    'extra.css': {
      kind: 'sheet',
      sheet: {
        text: '.extra { background: url(x.png) }',
        refs: [
          {
            range: { start: 25, end: 30 },
            kind: 'url',
            target: { kind: 'link', href: `${LINK}/x.png` },
          },
        ],
      },
    },
    'img/hero.jpg': {
      kind: 'asset',
      asset: asset('img/hero.jpg', sizes.hero ?? 5_000, 'image/jpeg'),
    },
    './app.js': { kind: 'module', name: 'dossier-export/app.js' },
    './lazy.js': { kind: 'module', name: 'dossier-export/lazy.js' },
    'vendor/classic.js': { kind: 'script', source: 'window.classic = 1' },
    'img/logo.png': {
      kind: 'asset',
      asset: asset('img/logo.png', 1_000, 'image/png'),
    },
    'img/small.png': {
      kind: 'asset',
      asset: asset('img/small.png', 2_000, 'image/png'),
    },
    'img/big.png': {
      kind: 'asset',
      asset: asset('img/big.png', 4_000, 'image/png'),
    },
    'media/walkthrough.mp4': {
      kind: 'asset',
      asset: asset('media/walkthrough.mp4', sizes.video ?? 10_000, 'video/mp4'),
    },
    'img/poster.jpg': {
      kind: 'asset',
      asset: asset('img/poster.jpg', 3_000, 'image/jpeg'),
    },
    'img/tile.png': {
      kind: 'asset',
      asset: asset('img/tile.png', 100, 'image/png'),
    },
    'notes.html#top': { kind: 'link', href: `${LINK}/notes#top` },
    'guides/setup/install': {
      kind: 'link',
      href: `${LINK}/guides/setup/install`,
    },
    '': { kind: 'text', text: '# Plan\n', type: 'text/markdown' },
    'guides/': { kind: 'text', text: '# guides/\n', type: 'text/markdown' },
    'v1/plan.md': {
      kind: 'asset',
      asset: asset('v1/plan.md', 50, 'text/markdown', { name: 'v1/plan.md' }),
    },
    'plan.md#diff': {
      kind: 'asset',
      asset: asset('plan.md', 60, 'text/markdown', { name: 'plan.md' }),
    },
    'app.js': { kind: 'module', name: 'dossier-export/app.js' },
  }
  for (const ref of refs) {
    const key =
      ref.kind === 'diff' && ref.url === 'plan.md' ? 'plan.md#diff' : ref.url
    const target = byUrl[key]
    if (target !== undefined) targets.set(ref, target)
  }
  const imports = new Map([
    [
      'dossier-export/app.js',
      {
        text: "import 'dossier-export/_components/acme-card.js'\nexport const start = () => {}",
        type: 'text/javascript',
      },
    ],
    ['dossier-export/lazy.js', { text: 'export {}', type: 'text/javascript' }],
    [
      'dossier-export/_components/acme-card.js',
      {
        text: 'customElements.define("acme-card", class extends HTMLElement {})',
        type: 'text/javascript',
      },
    ],
    [
      'dossier-export/base/lib/mermaid.js',
      { text: 'export const render = async () => {}', type: 'text/javascript' },
    ],
  ])
  const input: ExportInput = {
    html,
    refs,
    targets,
    imports,
    injected: injected.range,
    bootstrap: JSON.stringify({
      export: true,
      kit: { 'acme-card': 'dossier-export/_components/acme-card.js' },
    }),
    data: (linked) => JSON.stringify({ v: 1, linked, note: '</script>' }),
    client: 'window.client = "</script>"',
    header: {
      link: `${LINK}/plan`,
      by: 'sara@acme.com',
      at: '2026-10-11T12:00:00.000Z',
    },
  }
  return { input, refs }
}

/** The plan as text, each streamed file shown as a placeholder. */
const shown = (pieces: readonly ExportPiece[]): string =>
  pieces
    .map((piece) =>
      piece.kind === 'text'
        ? piece.text
        : `{{data:${piece.type} ${piece.sha256} ${piece.size}}}`,
    )
    .join('')

const planned = (input: ExportInput): ExportPlan => {
  const plan = planExport(input)
  if ('tooLarge' in plan) throw new Error(`too large: ${plan.tooLarge}`)
  return plan
}

describe('planExport', () => {
  test('inlines everything under the limit, as the golden file shows', () => {
    const plan = planned(fixtureInput().input)
    expect(plan.linked).toEqual([])
    expect(shown(plan.pieces)).toBe(fixture('export/page.expected.html'))
  })

  test('counts its size as the file will be, base64 growth included', () => {
    const plan = planned(fixtureInput().input)
    let bytes = 0
    for (const piece of plan.pieces) {
      bytes +=
        piece.kind === 'text'
          ? new TextEncoder().encode(piece.text).length
          : `data:${piece.type};base64,`.length + 4 * Math.ceil(piece.size / 3)
    }
    expect(plan.bytes).toBe(bytes)
    // A 10,000-byte video takes 13,336 bytes of base64 after its prefix.
    const video = plan.pieces.find(
      (piece) => piece.kind === 'data-url' && piece.type === 'video/mp4',
    )
    expect(video).toMatchObject({ size: 10_000 })
    expect(4 * Math.ceil(10_000 / 3)).toBe(13_336)
  })

  test('places the import map before any module script or module preload', () => {
    const text = shown(planned(fixtureInput().input).pieces)
    const map = text.indexOf('<script type="importmap">')
    expect(map).toBeGreaterThan(0)
    expect(text.indexOf('<script type="module"')).toBeGreaterThan(map)
    expect(text.indexOf('modulepreload')).toBe(-1)
    expect(text.indexOf('<script>window.client')).toBeGreaterThan(map)
    expect(text.indexOf('id="dossier-bootstrap"')).toBeLessThan(map)
  })

  test('links media largest first, whatever their kind, until the file fits', () => {
    // A 30 MiB video and a 25 MiB image: 73 MiB as base64, so the video goes.
    const both = planned(
      fixtureInput({ video: 30 * MiB, hero: 25 * MiB }).input,
    )
    expect(both.linked).toEqual([`${LINK}/media/walkthrough.mp4`])
    expect(both.bytes).toBeLessThanOrEqual(EXPORT_LIMIT_BYTES)
    // An image larger than the video goes first.
    const image = planned(
      fixtureInput({ video: 25 * MiB, hero: 30 * MiB }).input,
    )
    expect(image.linked).toEqual([`${LINK}/img/hero.jpg`])
    // Both, when one alone does not make it fit.
    const two = planned(fixtureInput({ video: 39 * MiB, hero: 40 * MiB }).input)
    expect(two.linked).toEqual([
      `${LINK}/img/hero.jpg`,
      `${LINK}/media/walkthrough.mp4`,
    ])
    const text = shown(two.pieces)
    expect(text).toContain(`<video src="${LINK}/media/walkthrough.mp4"`)
    expect(text).toContain(`url(${LINK}/img/hero.jpg)`)
    expect(text).not.toContain('{{data:video/mp4')
  })

  test('writes the header comment with what it linked', () => {
    const plan = planned(
      fixtureInput({ video: 30 * MiB, hero: 25 * MiB }).input,
    )
    const text = shown(plan.pieces)
    expect(
      text.startsWith(
        `<!-- Exported from ${LINK}/plan by sara@acme.com on 2026-10-11T12:00:00.000Z.\n` +
          `     Linked, not included: ${LINK}/media/walkthrough.mp4 -->\n<!doctype html>`,
      ),
    ).toBe(true)
    // The data the page reads names the same links.
    expect(text).toContain(`"linked":["${LINK}/media/walkthrough.mp4"]`)
    const none = shown(planned(fixtureInput().input).pieces)
    expect(
      none.startsWith(
        `<!-- Exported from ${LINK}/plan by sara@acme.com on 2026-10-11T12:00:00.000Z. -->\n`,
      ),
    ).toBe(true)
  })

  test('answers tooLarge when what is left alone passes the limit', () => {
    const { input, refs } = fixtureInput({ video: 30 * MiB })
    // The classic script is 38 MiB, about 50.7 MiB as base64: past the
    // limit even once the video is linked.
    const script = refs.find((ref) => ref.url === 'vendor/classic.js')!
    const targets = new Map(input.targets)
    const vendor = asset('vendor/classic.js', 38 * MiB, 'text/javascript')
    targets.set(script, { kind: 'asset', asset: vendor })
    const plan = planExport({ ...input, targets })
    expect(plan).toHaveProperty('tooLarge')
    const tooLarge = (plan as { tooLarge: number }).tooLarge
    expect(tooLarge).toBeGreaterThan(EXPORT_LIMIT_BYTES)
    expect(tooLarge).toBeGreaterThan(4 * Math.ceil((38 * MiB) / 3))
    // Every media file was linked before it gave up.
    const fits = planExport({
      ...input,
      targets: new Map([
        ...targets,
        [script, { kind: 'asset', asset: { ...vendor, size: 30 * MiB } }],
      ]),
    })
    expect(fits).toMatchObject({ linked: [`${LINK}/media/walkthrough.mp4`] })
  })

  test('keeps the inline JSON and client from ending their scripts', () => {
    const text = shown(planned(fixtureInput().input).pieces)
    expect(text).toContain('{"v":1,"linked":[],"note":"\\u003c/script>"}')
    expect(text).toContain('<script>window.client = "<\\/script>"</script>')
  })
})

describe('base64Of', () => {
  test('matches the platform for every remainder', () => {
    for (const bytes of ['', 'a', 'ab', 'abc', 'abcd', 'héllo wörld!']) {
      const data = new TextEncoder().encode(bytes)
      expect(base64Of(data)).toBe(Buffer.from(data).toString('base64'))
    }
  })
})
