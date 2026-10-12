import { describe, expect, it } from 'vitest'

import golden from './look-agent964.golden.txt?raw'
import {
  AGENT964_LOOK,
  checkLook,
  contrast,
  contrastChecks,
  lookCss,
  lookVersion,
  parseColor,
  PRESETS,
  scaleFrom,
  STEPS,
  type Look,
} from './look.ts'

describe('parseColor', () => {
  it('reads OKLCH as written, with a percentage or a number for lightness', () => {
    expect(parseColor('oklch(62.18% 0.1464 59.6)')).toMatchObject({
      oklch: { l: 0.6218, c: 0.1464 },
      alpha: 1,
      css: 'oklch(62.18% 0.1464 59.6)',
    })
    expect(parseColor('oklch(0.7 0.2 0)')?.css).toBe('oklch(70% 0.2 0)')
    expect(parseColor('OKLCH(70% 0.2 0deg / 40%)')?.css).toBe(
      'oklch(70% 0.2 0 / 40%)',
    )
  })

  it('reads HEX of three, four, six and eight digits', () => {
    expect(parseColor('#fff')?.oklch.l).toBeCloseTo(1, 3)
    expect(parseColor('#1F7A4D')?.css).toBe('#1f7a4d')
    expect(parseColor('#1d2a2224')?.alpha).toBeCloseTo(0x24 / 255, 5)
    expect(parseColor('#0008')?.alpha).toBeCloseTo(0x88 / 255, 5)
  })

  it('refuses anything else', () => {
    for (const text of [
      'red',
      'rgb(0 0 0)',
      'hsl(0 0% 0%)',
      '#12345',
      '#ggg',
      'oklch(120% 0.1 20)',
      'oklch(50% -0.1 20)',
      'oklch(50% 0.1)',
      'oklch(50% 0.1 20); } body { color: red',
      '',
    ]) {
      expect(parseColor(text), text).toBeNull()
    }
  })
})

describe('contrast', () => {
  it('gives 21 for black on white and the published ratios for known pairs', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    // #767676 is the lightest grey that passes AA on white: 4.54:1.
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2)
    // #595959 on white is 7.00:1, AAA for normal text.
    expect(contrast('#595959', '#ffffff')).toBeCloseTo(7.0, 2)
  })

  it('reads the same either way round', () => {
    expect(contrast('#ffffff', '#767676')).toBeCloseTo(
      contrast('#767676', '#ffffff'),
      10,
    )
  })
})

const lightnessOf = (text: string) => parseColor(text)!.oklch.l

describe('scaleFrom', () => {
  for (const [base, at] of [
    ['#ff7ab6', 300],
    ['oklch(70% 0.2 0)', 300],
    ['#1f7a4d', 700],
    ['#3eebff', 300],
    ['oklch(45% 0.1 250)', 950],
    ['#fdf6ff', 50],
  ] as const) {
    it(`returns eleven steps ordered by lightness around ${base} at ${at}`, () => {
      const scale = scaleFrom(base, at)
      expect(Object.keys(scale).map(Number)).toEqual([...STEPS])
      expect(scale[at]).toBe(parseColor(base)!.css)
      const lightness = STEPS.map((step) => lightnessOf(scale[step]))
      for (let i = 1; i < lightness.length; i += 1) {
        expect(lightness[i]!).toBeLessThan(lightness[i - 1]!)
      }
      for (const step of STEPS) expect(parseColor(scale[step])).not.toBeNull()
    })
  }
})

describe('lookVersion', () => {
  it('is stable for equal Looks, whatever their key order', async () => {
    const reordered = JSON.parse(
      JSON.stringify(AGENT964_LOOK, Object.keys(AGENT964_LOOK).reverse()),
    ) as Look
    const a = await lookVersion(AGENT964_LOOK)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(await lookVersion(structuredClone(AGENT964_LOOK))).toBe(a)
    expect(await lookVersion({ ...reordered, ...AGENT964_LOOK })).toBe(a)
  })

  it('changes with any value', async () => {
    const a = await lookVersion(AGENT964_LOOK)
    expect(await lookVersion({ ...AGENT964_LOOK, radius: 11 })).not.toBe(a)
    expect(await lookVersion({ ...AGENT964_LOOK, name: 'Acme' })).not.toBe(a)
  })
})

describe('lookCss', () => {
  it("writes agent964's Look as today's design tokens", () => {
    expect(lookCss(AGENT964_LOOK)).toBe(golden)
  })

  it('scopes the preview and names its families apart', () => {
    const css = lookCss(PRESETS.Studio, {
      scope: '[data-look-preview]',
      prefix: 'Dossier Preview',
    })
    expect(css).toContain('[data-look-preview] {')
    expect(css).toContain('font-family: "Dossier Preview Display"')
    expect(css).not.toContain(':root')
    expect(css).toContain('--brand-300: #ff7ab6;')
    expect(css).toContain('--radius: 16px;')
  })

  it('writes fonts from the deployment and the Arabic face into every stack', () => {
    const sha = 'a'.repeat(64)
    const css = lookCss({
      ...AGENT964_LOOK,
      fonts: {
        ...AGENT964_LOOK.fonts,
        body: {
          kind: 'google',
          family: 'Inter',
          faces: [
            {
              sha256: sha,
              format: 'woff2',
              weight: '400',
              style: 'normal',
              unicodeRange: 'U+0000-00FF',
            },
          ],
        },
      },
    })
    expect(css).toContain(`url("/_/fonts/${sha}.woff2") format("woff2")`)
    expect(css).not.toMatch(/googleapis|gstatic/)
    expect(css).toMatch(/--font-body: "Dossier Body", "Dossier Arabic"/)
  })
})

describe('the presets', () => {
  it('each pass every contrast check and read back as a Look', () => {
    for (const [name, look] of Object.entries(PRESETS)) {
      expect(
        contrastChecks(look).filter((check) => !check.ok),
        name,
      ).toEqual([])
      expect(checkLook(JSON.parse(JSON.stringify(look))), name).toEqual({
        look,
      })
    }
  })
})

describe('checkLook', () => {
  it('names a colour that does not parse', () => {
    const look = structuredClone(AGENT964_LOOK) as {
      palette: Record<string, Record<string, string>>
    }
    look.palette.brand!['300'] = 'cyan'
    expect(checkLook(look)).toEqual({
      problem: expect.stringContaining('brand-300 is not a colour'),
    })
  })

  it('refuses a radius past 24 and a name past 40 characters', () => {
    expect(checkLook({ ...AGENT964_LOOK, radius: 25 })).toHaveProperty(
      'problem',
    )
    expect(
      checkLook({ ...AGENT964_LOOK, name: 'x'.repeat(41) }),
    ).toHaveProperty('problem')
  })

  it('refuses a font family that could leave its quotes', () => {
    expect(
      checkLook({
        ...AGENT964_LOOK,
        fonts: {
          ...AGENT964_LOOK.fonts,
          body: {
            kind: 'upload',
            family: 'X"; } body { color: red',
            faces: [
              {
                sha256: 'b'.repeat(64),
                format: 'woff2',
                weight: '400',
                style: 'normal',
                unicodeRange: null,
              },
            ],
          },
        },
      }),
    ).toHaveProperty('problem')
  })
})
