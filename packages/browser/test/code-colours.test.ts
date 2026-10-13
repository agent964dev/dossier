import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

import { variableDefaults } from '../src/base/lib/highlighter.ts'

// Code colours must read at 4.5:1 wherever code is drawn: on the code
// background, and in <dossier-diff> on the tinted backgrounds of added and
// removed lines and on the stronger tint of the changed words in them.

type Rgb = readonly [number, number, number]

const hex = (text: string): Rgb => {
  const value = text.replace('#', '')
  return [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16) / 255) as [
    number,
    number,
    number,
  ]
}

const linear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
const gamma = (c: number) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055

const luminance = ([r, g, b]: Rgb) =>
  0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)

const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ]
  return (hi + 0.05) / (lo + 0.05)
}

// CSS color-mix(in lab, …): CIE Lab under D50, from sRGB through XYZ D65
// and the Bradford adaptation, as CSS Color 4 writes it.
const M = [
  [0.4360747, 0.3850649, 0.1430804],
  [0.2225045, 0.7168786, 0.0606169],
  [0.0139322, 0.0971045, 0.7141733],
] as const
const M_INV = [
  [3.1338561, -1.6168667, -0.4906146],
  [-0.9787684, 1.9161415, 0.033454],
  [0.0719453, -0.2289914, 1.4052427],
] as const
const WHITE = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585] as const
const E = 216 / 24389
const K = 24389 / 27

const times = (m: readonly (readonly number[])[], v: readonly number[]) =>
  m.map((row) => row.reduce((sum, x, i) => sum + x * v[i]!, 0))

const toLab = (rgb: Rgb): Rgb => {
  const xyz = times(M, rgb.map(linear)).map((v, i) => v / WHITE[i]!)
  const f = xyz.map((v) => (v > E ? Math.cbrt(v) : (K * v + 16) / 116))
  return [116 * f[1]! - 16, 500 * (f[0]! - f[1]!), 200 * (f[1]! - f[2]!)]
}

const fromLab = ([l, a, b]: Rgb): Rgb => {
  const fy = (l + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const xyz = [
    fx ** 3 > E ? fx ** 3 : (116 * fx - 16) / K,
    l > K * E ? fy ** 3 : l / K,
    fz ** 3 > E ? fz ** 3 : (116 * fz - 16) / K,
  ].map((v, i) => v * WHITE[i]!)
  return times(M_INV, xyz).map((v) =>
    Math.min(1, Math.max(0, gamma(v))),
  ) as unknown as Rgb
}

/** color-mix(in lab, a p%, b). */
const mixLab = (a: Rgb, p: number, b: Rgb): Rgb => {
  const [x, y] = [toLab(a), toLab(b)]
  return fromLab(x.map((v, i) => v * p + y[i]! * (1 - p)) as unknown as Rgb)
}

/** rgb(from fg r g b / alpha) over bg. */
const over = (fg: Rgb, alpha: number, bg: Rgb): Rgb =>
  fg.map((v, i) => v * alpha + bg[i]! * (1 - alpha)) as unknown as Rgb

/** Light and dark values of a --dossier-code- variable's default. */
const pairOf = (name: string): readonly [Rgb, Rgb] => {
  const match = /light-dark\((#[0-9a-f]{6}), (#[0-9a-f]{6})\)/i.exec(
    variableDefaults[name] ?? '',
  )
  if (match === null) throw new Error(`no default for ${name}`)
  return [hex(match[1]!), hex(match[2]!)]
}

// @pierre/diffs' tints, as its stylesheet writes them (checked below).
const SCHEMES = [
  { name: 'light', index: 0, line: 0.88, words: 0.15 },
  { name: 'dark', index: 1, line: 0.8, words: 0.2 },
] as const

/** Every surface code sits on, in one scheme. */
const surfacesOf = (scheme: (typeof SCHEMES)[number]) => {
  const at = (name: string) => pairOf(name)[scheme.index]
  const background = at('background')
  const added = mixLab(background, scheme.line, at('token-inserted'))
  const removed = mixLab(background, scheme.line, at('token-deleted'))
  return {
    background,
    'added lines': added,
    'removed lines': removed,
    'added words': over(at('token-inserted'), scheme.words, added),
    'removed words': over(at('token-deleted'), scheme.words, removed),
  }
}

/** The colours of a diff's own marks, which code text never takes in a diff. */
const MARKS = new Set(['token-inserted', 'token-deleted', 'token-changed'])

describe('code colours', () => {
  test('follow @pierre/diffs’ tints for changed lines and words', () => {
    const css = readFileSync(
      new URL('../node_modules/@pierre/diffs/dist/style.js', import.meta.url),
      'utf8',
    )
    for (const side of ['addition', 'deletion']) {
      expect(css).toContain(
        `--diffs-bg-${side}:var(--diffs-bg-${side}-override,light-dark(color-mix(in lab, var(--diffs-bg) 88%, var(--diffs-${side}-base)),color-mix(in lab, var(--diffs-bg) 80%, var(--diffs-${side}-base))))`,
      )
      expect(css).toContain(
        `--diffs-bg-${side}-emphasis:var(--diffs-bg-${side}-emphasis-override,light-dark(rgb(from var(--diffs-${side}-base) r g b / .15),rgb(from var(--diffs-${side}-base) r g b / .2)))`,
      )
    }
  })

  test('read at 4.5:1 on code and on every changed line and word of a diff', () => {
    const low: string[] = []
    for (const scheme of SCHEMES) {
      const surfaces = surfacesOf(scheme)
      for (const name of Object.keys(variableDefaults)) {
        if (name === 'background') continue
        const colour = pairOf(name)[scheme.index]
        const where = MARKS.has(name)
          ? { background: surfaces.background }
          : surfaces
        for (const [surface, under] of Object.entries(where)) {
          const ratio = contrast(colour, under)
          if (ratio < 4.5) {
            low.push(
              `${scheme.name} ${name} on ${surface}: ${ratio.toFixed(2)}`,
            )
          }
        }
      }
    }
    expect(low).toEqual([])
  })
})
