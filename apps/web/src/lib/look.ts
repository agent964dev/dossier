/**
 * The Look: how Dossier's own screens look on a deployment. Pure, so the
 * server and the Look screen share it: the palette, the roles that point
 * into it, the fonts per role and the corner radius, and the one stylesheet
 * that sets them as CSS variables.
 */
import {
  converter,
  modeLrgb,
  modeOklab,
  modeOklch,
  modeRgb,
  toGamut,
  useMode,
} from 'culori/fn'

useMode(modeRgb)
useMode(modeLrgb)
useMode(modeOklab)
useMode(modeOklch)

const toOklch = converter('oklch')
const toRgb = converter('rgb')
const inRgb = toGamut('rgb', 'oklch')

export type ScaleName =
  | 'neutral'
  | 'brand'
  | 'accent'
  | 'complement'
  | 'success'
  | 'warning'
  | 'error'
export type Step =
  | 50
  | 100
  | 200
  | 300
  | 400
  | 500
  | 600
  | 700
  | 800
  | 900
  | 950
/** As typed: 'oklch(62.18% 0.1464 59.6)' or '#1f7a4d'. */
export type ColorText = string
export type RoleName =
  | 'background'
  | 'foreground'
  | 'card'
  | 'card-foreground'
  | 'popover'
  | 'popover-foreground'
  | 'primary'
  | 'primary-foreground'
  | 'secondary'
  | 'secondary-foreground'
  | 'muted'
  | 'muted-foreground'
  | 'accent'
  | 'accent-foreground'
  | 'destructive'
  | 'destructive-foreground'
  | 'border'
  | 'input'
  | 'ring'
/** One step of the palette as its CSS variable name, `brand-300`. */
export type StepName = `${ScaleName}-${Step}`
/** A step of the palette, seen through `alpha` (0 to 1) when given, or a colour. */
export type RoleValue =
  | { readonly step: StepName; readonly alpha?: number }
  | { readonly color: ColorText }
export type FontRole = 'display' | 'body' | 'mono' | 'arabic'
export interface FontFaceFile {
  readonly sha256: string
  readonly format: 'woff2' | 'woff' | 'truetype' | 'opentype'
  /** '400', or a range such as '100 900' for a variable file. */
  readonly weight: string
  readonly style: 'normal' | 'italic'
  readonly unicodeRange: string | null
}
export type SystemFamily = 'serif' | 'sans-serif' | 'monospace'
export type FontChoice =
  /** A face Dossier ships in /_/app/fonts/: the role's own, or another role's. */
  | { readonly kind: 'agent964'; readonly face?: FontRole }
  /** The device's own fonts of a kind; nothing is downloaded. */
  | { readonly kind: 'system'; readonly family: SystemFamily }
  | {
      readonly kind: 'google'
      readonly family: string
      readonly faces: readonly FontFaceFile[]
    }
  | {
      readonly kind: 'upload'
      readonly family: string
      readonly faces: readonly FontFaceFile[]
    }
export type LogoType = 'image/png' | 'image/webp' | 'image/svg+xml'
export interface Look {
  readonly v: 1
  /** At most 40 characters; empty shows "Dossier". */
  readonly name: string
  readonly logo: { readonly sha256: string; readonly type: LogoType } | null
  readonly palette: Readonly<
    Record<ScaleName, Readonly<Record<Step, ColorText>>>
  >
  /** Overrides of DEFAULT_ROLES. */
  readonly roles: Partial<Readonly<Record<RoleName, RoleValue>>>
  readonly fonts: Readonly<Record<FontRole, FontChoice>>
  /** px, 0 to 24. */
  readonly radius: number
}

export const SCALES: readonly ScaleName[] = [
  'neutral',
  'brand',
  'accent',
  'complement',
  'success',
  'warning',
  'error',
]
export const STEPS: readonly Step[] = [
  50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
]
export const ROLES: readonly RoleName[] = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
]
export const FONT_ROLES: readonly FontRole[] = [
  'display',
  'body',
  'mono',
  'arabic',
]
export const NAME_MAX = 40
export const RADIUS_MAX = 24
/** WCAG 2.2 AA for normal text. */
export const MIN_CONTRAST = 4.5

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

export interface ParsedColor {
  readonly oklch: { readonly l: number; readonly c: number; readonly h: number }
  /** 0 to 1. */
  readonly alpha: number
  /** The colour as the stylesheet writes it. */
  readonly css: string
}

const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?`
const OKLCH = new RegExp(
  String.raw`^oklch\(\s*(${NUMBER})(%?)\s+(${NUMBER})(%?)\s+(${NUMBER}|none)(deg)?\s*(?:\/\s*(${NUMBER})(%?)\s*)?\)$`,
  'i',
)
const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** A number with at most `digits` decimals and no trailing zeros. */
const num = (value: number, digits: number): string => {
  const fixed = Number(value.toFixed(digits))
  return Object.is(fixed, -0) ? '0' : String(fixed)
}

const alphaText = (alpha: number) => `${num(alpha * 100, 1)}%`

const oklchText = (
  { l, c, h }: { l: number; c: number; h: number },
  alpha = 1,
) =>
  `oklch(${num(l * 100, 2)}% ${num(c, 4)} ${num(h, 2)}${alpha < 1 ? ` / ${alphaText(alpha)}` : ''})`

/** OKLCH or HEX, else null. Nothing else is a colour here. */
export const parseColor = (text: ColorText): ParsedColor | null => {
  const value = text.trim()
  const oklch = OKLCH.exec(value)
  if (oklch !== null) {
    const [, l, lp, c, cp, h, , a, ap] = oklch
    const light = Number(l) / (lp === '%' ? 100 : 1)
    const chroma = cp === '%' ? (Number(c) / 100) * 0.4 : Number(c)
    const hue = h?.toLowerCase() === 'none' ? 0 : Number(h)
    const alpha = a === undefined ? 1 : Number(a) / (ap === '%' ? 100 : 1)
    if (
      ![light, chroma, hue, alpha].every(Number.isFinite) ||
      light < 0 ||
      light > 1 ||
      chroma < 0 ||
      chroma > 0.5 ||
      alpha < 0 ||
      alpha > 1
    ) {
      return null
    }
    const color = { l: light, c: chroma, h: ((hue % 360) + 360) % 360 }
    return { oklch: color, alpha, css: oklchText(color, alpha) }
  }
  const hex = HEX.exec(value)
  if (hex !== null) {
    const digits = hex[1]!.toLowerCase()
    const full =
      digits.length <= 4 ? [...digits].map((d) => d + d).join('') : digits
    const channel = (i: number) => parseInt(full.slice(i * 2, i * 2 + 2), 16)
    const alpha = full.length === 8 ? channel(3) / 255 : 1
    const found = toOklch({
      mode: 'rgb',
      r: channel(0) / 255,
      g: channel(1) / 255,
      b: channel(2) / 255,
    })
    return {
      oklch: { l: found.l, c: found.c, h: found.h ?? 0 },
      alpha,
      css: `#${digits}`,
    }
  }
  return null
}

const rgbOf = ({ oklch }: ParsedColor): readonly [number, number, number] => {
  const { r, g, b } = toRgb({ mode: 'oklch', ...oklch })
  const clip = (v: number) => Math.min(1, Math.max(0, v))
  return [clip(r), clip(g), clip(b)]
}

/** `top` seen through its alpha over the opaque `under`. */
const over = (
  top: ParsedColor,
  under: readonly [number, number, number],
): readonly [number, number, number] => {
  const rgb = rgbOf(top)
  return [0, 1, 2].map(
    (i) => rgb[i]! * top.alpha + under[i]! * (1 - top.alpha),
  ) as unknown as readonly [number, number, number]
}

const luminance = ([r, g, b]: readonly [number, number, number]) => {
  const linear = (v: number) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

const ratio = (a: number, b: number) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

const BLACK = [0, 0, 0] as const

/** The WCAG 2 contrast ratio, 1 to 21; 1 when either is not a colour. */
export const contrast = (
  foreground: ColorText,
  background: ColorText,
): number => {
  const fg = parseColor(foreground)
  const bg = parseColor(background)
  if (fg === null || bg === null) return 1
  const under = over(bg, BLACK)
  return ratio(luminance(over(fg, under)), luminance(under))
}

/** The shared lightness ladder of agent964's scales. */
const LADDER: Readonly<Record<Step, number>> = {
  50: 0.96,
  100: 0.9418,
  200: 0.9085,
  300: 0.8654,
  400: 0.7383,
  500: 0.6215,
  600: 0.5158,
  700: 0.4227,
  800: 0.344,
  900: 0.2832,
  950: 0.25,
}

/** How colourful each step is beside the most colourful middle steps. */
const CHROMA: Readonly<Record<Step, number>> = {
  50: 0.25,
  100: 0.35,
  200: 0.5,
  300: 0.8,
  400: 0.95,
  500: 1,
  600: 0.92,
  700: 0.78,
  800: 0.62,
  900: 0.5,
  950: 0.42,
}

/**
 * Eleven steps around one colour placed at `at`: its hue, the ladder's
 * lightness spacing stretched to fit around the colour's own lightness, and
 * a chroma that fades towards both ends, kept inside sRGB. Step `at` is the
 * colour as typed.
 */
export const scaleFrom = (
  base: ColorText,
  at: Step,
): Readonly<Record<Step, ColorText>> => {
  const parsed = parseColor(base)
  if (parsed === null) throw new Error(`Not a colour: ${base}`)
  const { l, c, h } = parsed.oklch
  const top = Math.max(0.985, l)
  const bottom = Math.min(0.17, l)
  const anchor = LADDER[at]
  const lightness = (step: Step) => {
    const rung = LADDER[step]
    if (rung === anchor) return l
    return rung > anchor
      ? l + ((rung - anchor) / (LADDER[50] - anchor)) * (top - l)
      : l - ((anchor - rung) / (anchor - LADDER[950])) * (l - bottom)
  }
  const out = {} as Record<Step, ColorText>
  for (const step of STEPS) {
    if (step === at) {
      out[step] = parsed.css
      continue
    }
    // Kept inside sRGB, then read back as OKLCH.
    const color = toOklch(
      inRgb({
        mode: 'oklch',
        l: lightness(step),
        c: (c * CHROMA[step]) / CHROMA[at],
        h,
      }),
    )
    out[step] = oklchText({
      l: Math.min(1, Math.max(0, color.l)),
      c: Math.max(0, color.c ?? 0),
      h,
    })
  }
  return out
}

/** A palette scale read the other way: 50 becomes 950. */
const reversed = (
  scale: Readonly<Record<Step, ColorText>>,
): Readonly<Record<Step, ColorText>> =>
  Object.fromEntries(
    STEPS.map((step, i) => [step, scale[STEPS[STEPS.length - 1 - i]!]]),
  ) as Record<Step, ColorText>

// ---------------------------------------------------------------------------
// agent964 and the presets
// ---------------------------------------------------------------------------

const scaleOf = (values: readonly ColorText[]) =>
  Object.fromEntries(STEPS.map((step, i) => [step, values[i]!])) as Record<
    Step,
    ColorText
  >

const AGENT964_PALETTE: Look['palette'] = {
  neutral: scaleOf([
    'oklch(99.24% 0 0)',
    'oklch(97.71% 0.0024 194)',
    'oklch(93.09% 0.0087 200.1)',
    'oklch(85.16% 0.0167 206.3)',
    'oklch(73.96% 0.0245 212.6)',
    'oklch(59.57% 0.0297 218.6)',
    'oklch(44.94% 0.0313 224)',
    'oklch(33.2% 0.0303 228.6)',
    'oklch(24.6% 0.0276 232.1)',
    'oklch(19.26% 0.0253 234.3)',
    'oklch(16.9% 0.0286 232.6)',
  ]),
  brand: scaleOf([
    'oklch(96% 0.0412 207.1)',
    'oklch(94.18% 0.0523 207.1)',
    'oklch(90.85% 0.0553 207.1)',
    'oklch(86.54% 0.1367 207.1)',
    'oklch(73.83% 0.138 207.1)',
    'oklch(62.15% 0.1294 207.1)',
    'oklch(51.58% 0.1169 207.1)',
    'oklch(42.27% 0.0958 207.1)',
    'oklch(34.4% 0.078 207.1)',
    'oklch(28.32% 0.0642 207.1)',
    'oklch(25% 0.0567 207.1)',
  ]),
  accent: scaleOf([
    'oklch(96% 0.0205 267.3)',
    'oklch(94.18% 0.026 267.3)',
    'oklch(90.85% 0.0276 267.3)',
    'oklch(86.54% 0.0684 267.3)',
    'oklch(73.83% 0.1188 267.3)',
    'oklch(62.15% 0.1988 267.3)',
    'oklch(51.58% 0.286 267.3)',
    'oklch(42.27% 0.2816 267.3)',
    'oklch(34.4% 0.2292 267.3)',
    'oklch(28.32% 0.1887 267.3)',
    'oklch(25% 0.1666 267.3)',
  ]),
  complement: scaleOf([
    'oklch(96% 0.0315 60.4)',
    'oklch(94.18% 0.0397 60.4)',
    'oklch(90.85% 0.0425 60.4)',
    'oklch(86.54% 0.1086 60.4)',
    'oklch(73.83% 0.1585 60.4)',
    'oklch(62.15% 0.1487 60.4)',
    'oklch(51.58% 0.1352 60.4)',
    'oklch(42.27% 0.1117 60.4)',
    'oklch(34.4% 0.0909 60.4)',
    'oklch(28.32% 0.0749 60.4)',
    'oklch(25% 0.0661 60.4)',
  ]),
  success: scaleOf([
    'oklch(96% 0.0758 145.8)',
    'oklch(94.18% 0.1085 145.8)',
    'oklch(90.85% 0.1213 145.8)',
    'oklch(86.54% 0.2981 145.8)',
    'oklch(73.83% 0.2859 145.8)',
    'oklch(62.15% 0.2661 145.8)',
    'oklch(51.58% 0.2209 145.8)',
    'oklch(42.27% 0.181 145.8)',
    'oklch(34.4% 0.1473 145.8)',
    'oklch(28.32% 0.1213 145.8)',
    'oklch(25% 0.1071 145.8)',
  ]),
  warning: scaleOf([
    'oklch(96% 0.0495 83.5)',
    'oklch(94.18% 0.0705 83.5)',
    'oklch(90.85% 0.0749 83.5)',
    'oklch(86.54% 0.1666 83.5)',
    'oklch(73.83% 0.1598 83.5)',
    'oklch(62.15% 0.1456 83.5)',
    'oklch(51.58% 0.1209 83.5)',
    'oklch(42.27% 0.0991 83.5)',
    'oklch(34.4% 0.0806 83.5)',
    'oklch(28.32% 0.0664 83.5)',
    'oklch(25% 0.0586 83.5)',
  ]),
  error: scaleOf([
    'oklch(96% 0.0255 27.4)',
    'oklch(94.18% 0.032 27.4)',
    'oklch(90.85% 0.0345 27.4)',
    'oklch(86.54% 0.0889 27.4)',
    'oklch(73.83% 0.1633 27.4)',
    'oklch(62.15% 0.2549 27.4)',
    'oklch(51.58% 0.2319 27.4)',
    'oklch(42.27% 0.1924 27.4)',
    'oklch(34.4% 0.1566 27.4)',
    'oklch(28.32% 0.1289 27.4)',
    'oklch(25% 0.1138 27.4)',
  ]),
}

/** Which step each role uses unless a Look points it elsewhere. */
export const DEFAULT_ROLES: Readonly<Record<RoleName, RoleValue>> = {
  background: { step: 'neutral-950' },
  foreground: { step: 'neutral-50' },
  card: { step: 'neutral-900' },
  'card-foreground': { step: 'neutral-50' },
  popover: { step: 'neutral-900' },
  'popover-foreground': { step: 'neutral-50' },
  primary: { step: 'brand-300' },
  'primary-foreground': { step: 'neutral-950' },
  secondary: { step: 'neutral-800' },
  'secondary-foreground': { step: 'neutral-100' },
  muted: { step: 'neutral-800' },
  'muted-foreground': { step: 'neutral-500' },
  accent: { step: 'accent-500' },
  'accent-foreground': { step: 'neutral-50' },
  destructive: { step: 'error-500' },
  'destructive-foreground': { step: 'neutral-50' },
  border: { step: 'neutral-700', alpha: 0.4 },
  input: { step: 'neutral-800', alpha: 0.8 },
  ring: { step: 'brand-300' },
}

const AGENT964_FONTS: Look['fonts'] = {
  display: { kind: 'agent964' },
  body: { kind: 'agent964' },
  mono: { kind: 'agent964' },
  arabic: { kind: 'agent964' },
}

/** agent964's design language, as Dossier's screens have always looked. */
export const AGENT964_LOOK: Look = {
  v: 1,
  name: '',
  logo: null,
  palette: AGENT964_PALETTE,
  // agent964's red for actions that remove is a little darker than error-500.
  roles: { destructive: { color: 'oklch(58.42% 0.2603 27.4)' } },
  fonts: AGENT964_FONTS,
  radius: 10,
}

/** Light paper, ink and a deep green, with serif headings. */
const ACME_LOOK: Look = {
  v: 1,
  name: 'Acme Docs',
  logo: null,
  palette: {
    neutral: scaleOf([
      '#1d2a22',
      '#25332a',
      '#33443a',
      '#4a5a50',
      '#55635a',
      '#5f6d64',
      '#a3ad9f',
      '#d3cfbe',
      '#ece8dc',
      '#ffffff',
      '#f7f5ee',
    ]),
    brand: reversed(scaleFrom('#1f7a4d', 700)),
    accent: reversed(scaleFrom('#7aa98a', 500)),
    complement: reversed(AGENT964_PALETTE.complement),
    success: reversed(AGENT964_PALETTE.success),
    warning: reversed(AGENT964_PALETTE.warning),
    error: reversed(AGENT964_PALETTE.error),
  },
  roles: {
    'primary-foreground': { color: '#ffffff' },
    destructive: { color: '#b4232c' },
    border: { color: '#1d2a2224' },
    input: { color: '#ffffff' },
  },
  fonts: { ...AGENT964_FONTS, display: { kind: 'system', family: 'serif' } },
  radius: 4,
}

/** Violet greys and a pink brand, set in Geist throughout. */
const STUDIO_LOOK: Look = {
  v: 1,
  name: 'Studio Files',
  logo: null,
  palette: {
    neutral: scaleOf([
      '#f7f5fb',
      '#ece9f4',
      '#ddd8ea',
      '#c9c3da',
      '#aaa2bf',
      '#8d84a4',
      '#5a5170',
      '#3b3350',
      '#2a2438',
      '#1b1726',
      '#120f1a',
    ]),
    brand: scaleFrom('#ff7ab6', 300),
    accent: scaleFrom('#9b6bff', 500),
    complement: AGENT964_PALETTE.complement,
    success: AGENT964_PALETTE.success,
    warning: AGENT964_PALETTE.warning,
    error: AGENT964_PALETTE.error,
  },
  roles: {
    'primary-foreground': { color: '#1b0f16' },
    destructive: { color: 'oklch(58.42% 0.2603 27.4)' },
  },
  fonts: { ...AGENT964_FONTS, display: { kind: 'agent964', face: 'body' } },
  radius: 16,
}

export type PresetName = 'agent964' | 'Acme' | 'Studio'

export const PRESETS: Readonly<Record<PresetName, Look>> = {
  agent964: AGENT964_LOOK,
  Acme: ACME_LOOK,
  Studio: STUDIO_LOOK,
}

// ---------------------------------------------------------------------------
// Roles and contrast
// ---------------------------------------------------------------------------

const FALLBACK = parseColor('#000000')!

const stepOf = (value: string): { scale: ScaleName; step: Step } | null => {
  const at = value.lastIndexOf('-')
  const scale = value.slice(0, at) as ScaleName
  const step = Number(value.slice(at + 1)) as Step
  return SCALES.includes(scale) && STEPS.includes(step) ? { scale, step } : null
}

/** A role's colour in a Look, with the text the stylesheet writes for it. */
export const roleColor = (look: Look, role: RoleName): ParsedColor => {
  const value = look.roles[role] ?? DEFAULT_ROLES[role]
  if ('color' in value) return parseColor(value.color) ?? FALLBACK
  const at = stepOf(value.step)
  const base =
    at === null ? null : parseColor(look.palette[at.scale][at.step] ?? '')
  if (base === null) return FALLBACK
  const alpha = base.alpha * (value.alpha ?? 1)
  return alpha === base.alpha
    ? base
    : { ...base, alpha, css: oklchText(base.oklch, alpha) }
}

/** A colour as the screens name it: a role, or a step of the palette. */
type TextColour = RoleName | StepName

/** Where text sits: the surfaces the screens put text on. */
type Surface =
  | 'background'
  | 'card'
  | 'popover'
  | 'primary'
  | 'secondary'
  | 'input'
  | 'input-card'

const SURFACE_NAMES: Readonly<Record<Surface, string>> = {
  background: 'background',
  card: 'cards',
  popover: 'menus',
  primary: 'primary',
  secondary: 'secondary buttons',
  input: 'fields',
  'input-card': 'fields on cards',
}

/** Steps the screens use for text, from headings to quiet labels. */
const TEXT_STEPS: readonly StepName[] = [
  'neutral-50',
  'neutral-100',
  'neutral-200',
  'neutral-300',
  'neutral-400',
]
/** Links, badges and messages: coloured text on the page and on cards. */
const COLOURED_TEXT: readonly TextColour[] = [
  'primary',
  'brand-100',
  'brand-200',
  'brand-300',
  'error-200',
  'error-300',
  'success-300',
  'warning-100',
  'warning-300',
  'complement-400',
]

/**
 * Text the screens put on a field's surface: what people type, and the
 * placeholders, prompts and hints inside fields, which use neutral-400 (the
 * muted colour is too faint on a field).
 */
export const FIELD_TEXT: readonly string[] = TEXT_STEPS

const on = (
  colours: readonly TextColour[],
  surfaces: readonly Surface[],
): readonly (readonly [TextColour, Surface])[] =>
  surfaces.flatMap((surface) =>
    colours.map((colour) => [colour, surface] as const),
  )

/**
 * The lines of the contrast check. Each holds every pair of a text colour
 * and the surface the screens put it on, roles and palette steps alike, so
 * a Look that passes is readable wherever the screens use it.
 */
const CHECKS: readonly {
  readonly pair: string
  readonly members: readonly (readonly [TextColour, Surface])[]
}[] = [
  {
    pair: 'Text on background',
    members: [['foreground', 'background'], ...on(TEXT_STEPS, ['background'])],
  },
  {
    pair: 'Text on cards',
    members: [
      ['card-foreground', 'card'],
      ['popover-foreground', 'popover'],
      ...on(TEXT_STEPS, ['card', 'popover']),
    ],
  },
  {
    pair: 'Text on buttons',
    members: [
      ['primary-foreground', 'primary'],
      ['secondary-foreground', 'secondary'],
    ],
  },
  {
    pair: 'Text on fields',
    members: on(TEXT_STEPS, ['input', 'input-card']),
  },
  {
    pair: 'Muted text',
    members: on(['muted-foreground', 'neutral-500'], ['background', 'card']),
  },
  {
    pair: 'Links and status text',
    members: on(COLOURED_TEXT, ['background', 'card']),
  },
]

/** Every text colour the contrast check covers. */
export const CHECKED_TEXT: readonly string[] = [
  ...new Set(CHECKS.flatMap((check) => check.members.map(([fg]) => fg))),
]

/** Text colours the screens use where contrast does not apply, and why. */
export const TEXT_EXEMPT: Readonly<Record<string, string>> = {
  'neutral-600':
    'separators hidden from assistive technology, and the dash of an empty answer',
  'neutral-950':
    'text of the solid success and warning buttons, which no screen uses',
}

const colourOf = (look: Look, name: TextColour): ParsedColor => {
  if ((ROLES as readonly string[]).includes(name)) {
    return roleColor(look, name as RoleName)
  }
  const at = stepOf(name)
  return (
    (at === null ? null : parseColor(look.palette[at.scale][at.step])) ??
    FALLBACK
  )
}

/**
 * The contrast check, line by line: the lowest ratio among the line's
 * pairs and which pair it is (WCAG 2.2 AA asks 4.5:1 of each).
 */
export const contrastChecks = (
  look: Look,
): readonly {
  readonly pair: string
  readonly ratio: number
  readonly ok: boolean
  /** The pair with the lowest ratio, such as "neutral-50 on cards". */
  readonly worst: string
}[] => {
  const background = over(roleColor(look, 'background'), BLACK)
  const card = over(roleColor(look, 'card'), background)
  const surface = (name: Surface) =>
    name === 'background'
      ? background
      : name === 'input-card'
        ? over(roleColor(look, 'input'), card)
        : over(roleColor(look, name), background)
  return CHECKS.map(({ pair, members }) => {
    let lowest = Number.POSITIVE_INFINITY
    let worst = ''
    for (const [fg, bg] of members) {
      const under = surface(bg)
      const value = ratio(
        luminance(over(colourOf(look, fg), under)),
        luminance(under),
      )
      if (value < lowest) {
        lowest = value
        worst = `${fg} on ${SURFACE_NAMES[bg]}`
      }
    }
    // Shown rounded down, so a pair just below the bar never reads 4.5:1.
    return {
      pair,
      ratio: Math.floor(lowest * 10) / 10,
      ok: lowest >= MIN_CONTRAST,
      worst,
    }
  })
}

/** "14.2:1". */
export const ratioText = (value: number) => `${value.toFixed(1)}:1`

const hexOf = ([r, g, b]: readonly [number, number, number]) =>
  `#${[r, g, b]
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`

/** The background as HEX, for the browser's own chrome. */
export const backgroundHex = (look: Look) =>
  hexOf(over(roleColor(look, 'background'), BLACK))

/** Light Looks ask the browser for light form controls and scrollbars. */
export const schemeOf = (look: Look): 'light' | 'dark' =>
  luminance(over(roleColor(look, 'background'), BLACK)) > 0.4 ? 'light' : 'dark'

// ---------------------------------------------------------------------------
// Fonts and the stylesheet
// ---------------------------------------------------------------------------

/** Where the built-in faces' Arabic file applies. */
export const ARABIC_RANGE =
  'U+0600-06FF, U+0750-077F, U+0870-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FEFF'

interface BuiltInFace {
  readonly file: string
  readonly weight: string
  readonly unicodeRange: string | null
}

/** The faces Dossier ships for each role, under /_/app/fonts/. */
export const BUILT_IN: Readonly<
  Record<
    FontRole,
    { readonly family: string; readonly faces: readonly BuiltInFace[] }
  >
> = {
  display: {
    family: 'Clash Display',
    faces: [
      {
        file: 'ClashDisplay-Variable.woff2',
        weight: '200 700',
        unicodeRange: null,
      },
    ],
  },
  body: {
    family: 'Geist',
    faces: [
      { file: 'Geist-Variable.woff2', weight: '100 900', unicodeRange: null },
    ],
  },
  mono: {
    family: 'Geist Mono',
    faces: [
      {
        file: 'GeistMono-Variable.woff2',
        weight: '100 900',
        unicodeRange: null,
      },
    ],
  },
  arabic: {
    family: 'Tajawal',
    faces: [
      {
        file: 'Tajawal-Regular.woff2',
        weight: '400',
        unicodeRange: ARABIC_RANGE,
      },
      {
        file: 'Tajawal-Medium.woff2',
        weight: '500',
        unicodeRange: ARABIC_RANGE,
      },
      { file: 'Tajawal-Bold.woff2', weight: '700', unicodeRange: ARABIC_RANGE },
    ],
  },
}

export const SYSTEM_STACKS: Readonly<
  Record<SystemFamily, { readonly label: string; readonly families: string }>
> = {
  serif: {
    label: 'Serif',
    families: 'Georgia, Charter, "Iowan Old Style", "Times New Roman", serif',
  },
  'sans-serif': {
    label: 'Sans serif',
    families: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  },
  monospace: {
    label: 'Monospace',
    families: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  },
}

/** A system family's stack, never a property every object has. */
const systemStack = (family: string) =>
  Object.hasOwn(SYSTEM_STACKS, family)
    ? SYSTEM_STACKS[family as SystemFamily]
    : SYSTEM_STACKS['sans-serif']

const EXTENSIONS: Readonly<Record<FontFaceFile['format'], string>> = {
  woff2: 'woff2',
  woff: 'woff',
  truetype: 'ttf',
  opentype: 'otf',
}

/** Where the deployment serves a copied or uploaded font file. */
export const fontUrl = (face: Pick<FontFaceFile, 'sha256' | 'format'>) =>
  `/_/fonts/${face.sha256}.${EXTENSIONS[face.format]}`

/** Where the deployment serves the Look's logo. */
export const logoUrl = (logo: NonNullable<Look['logo']>) =>
  `/_/look/logo-${logo.sha256}`

/** The family a role's choice shows, as the screen names it. */
export const familyOf = (role: FontRole, choice: FontChoice): string => {
  switch (choice.kind) {
    case 'agent964':
      return BUILT_IN[choice.face ?? role].family
    case 'system':
      return systemStack(choice.family).label
    default:
      return choice.family
  }
}

/** The files to preload for a Look's display and body faces. */
export const builtInPreloads = (look: Look): readonly string[] =>
  (['display', 'body'] as const).flatMap((role) => {
    const choice = look.fonts[role]
    return choice.kind === 'agent964'
      ? BUILT_IN[choice.face ?? role].faces
          .filter((face) => face.unicodeRange === null)
          .map((face) => `/_/app/fonts/${face.file}`)
      : []
  })

const ROLE_TITLES: Readonly<Record<FontRole, string>> = {
  display: 'Display',
  body: 'Body',
  mono: 'Mono',
  arabic: 'Arabic',
}

const FALLBACKS: Readonly<
  Record<
    FontRole,
    { readonly also: readonly FontRole[]; readonly generic: string }
  >
> = {
  display: { also: ['body', 'arabic'], generic: 'system-ui, sans-serif' },
  body: { also: ['arabic'], generic: 'system-ui, -apple-system, sans-serif' },
  mono: {
    also: ['arabic'],
    generic:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  },
  arabic: {
    also: [],
    generic: '"Tajawal", "Geeza Pro", "Noto Sans Arabic", sans-serif',
  },
}

export interface LookCssOptions {
  /** The rule the variables go in: ':root', or the preview's container. */
  readonly scope?: string
  /** Families are named "<prefix> Display" and so on. */
  readonly prefix?: string
}

const UNICODE_RANGE =
  /^[Uu]\+[0-9A-Fa-f?]{1,6}(-[0-9A-Fa-f]{1,6})?(\s*,\s*[Uu]\+[0-9A-Fa-f?]{1,6}(-[0-9A-Fa-f]{1,6})?)*$/
const WEIGHT = /^\d{1,4}( \d{1,4})?$/
const SHA256 = /^[0-9a-f]{64}$/

const fontFace = (
  family: string,
  src: string,
  weight: string,
  style: string,
  unicodeRange: string | null,
) =>
  [
    '@font-face {',
    `  font-family: "${family}";`,
    `  src: ${src};`,
    `  font-weight: ${weight};`,
    `  font-style: ${style};`,
    ...(unicodeRange === null ? [] : [`  unicode-range: ${unicodeRange};`]),
    '  font-display: swap;',
    '}',
  ].join('\n')

const facesOf = (role: FontRole, choice: FontChoice, family: string) => {
  switch (choice.kind) {
    case 'system':
      return []
    case 'agent964':
      return BUILT_IN[choice.face ?? role].faces.map((face) =>
        fontFace(
          family,
          `url("/_/app/fonts/${face.file}") format("woff2")`,
          face.weight,
          'normal',
          face.unicodeRange,
        ),
      )
    default:
      // Checked again here: only these characters ever reach the sheet.
      return choice.faces
        .filter(
          (face) =>
            SHA256.test(face.sha256) &&
            Object.hasOwn(EXTENSIONS, face.format) &&
            WEIGHT.test(face.weight) &&
            (face.style === 'normal' || face.style === 'italic') &&
            (face.unicodeRange === null ||
              UNICODE_RANGE.test(face.unicodeRange)),
        )
        .map((face) =>
          fontFace(
            family,
            `url("${fontUrl(face)}") format("${face.format}")`,
            face.weight,
            face.style,
            face.unicodeRange,
          ),
        )
  }
}

/**
 * The stylesheet of a Look: an @font-face per chosen face, then every
 * palette step, role, the radius and the four font stacks as variables.
 * Every colour is written from its parsed value, so nothing typed reaches
 * the sheet as it was typed.
 */
export const lookCss = (look: Look, options: LookCssOptions = {}): string => {
  const scope = options.scope ?? ':root'
  const prefix = options.prefix ?? 'Dossier'
  const family = (role: FontRole) => `${prefix} ${ROLE_TITLES[role]}`
  const faces = FONT_ROLES.flatMap((role) =>
    facesOf(role, look.fonts[role], family(role)),
  )
  const stack = (role: FontRole) => {
    const choice = look.fonts[role]
    const { also, generic } = FALLBACKS[role]
    const first =
      choice.kind === 'system'
        ? systemStack(choice.family).families.split(/,\s*/)
        : [`"${family(role)}"`]
    const tail =
      choice.kind === 'system' ? [first.pop()!] : generic.split(/,\s*/)
    return [
      ...first,
      ...also.map((other) => `"${family(other)}"`),
      ...tail,
    ].join(', ')
  }
  const palette = SCALES.flatMap((name) =>
    STEPS.map(
      (step) =>
        `  --${name}-${step}: ${(parseColor(look.palette[name][step]) ?? parseColor(AGENT964_PALETTE[name][step])!).css};`,
    ),
  )
  const roles = ROLES.map(
    (role) => `  --${role}: ${roleColor(look, role).css};`,
  )
  const radius = Math.min(RADIUS_MAX, Math.max(0, Math.round(look.radius)))
  const local =
    scope === ':root'
      ? []
      : [
          '  background-color: var(--background);',
          '  color: var(--foreground);',
          '  font-family: var(--font-body);',
        ]
  return [
    ...faces,
    `${scope} {`,
    `  color-scheme: ${schemeOf(look)};`,
    ...palette,
    ...roles,
    `  --glow-cyan: ${roleColor(look, 'primary').css};`,
    `  --radius: ${radius}px;`,
    ...FONT_ROLES.map((role) => `  --font-${role}: ${stack(role)};`),
    ...local,
    '}',
    '',
  ].join('\n')
}

/** Object keys in order, so equal Looks write equal JSON. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [
              key,
              canonical((value as Record<string, unknown>)[key]),
            ]),
        )
      : value

/** Two Looks hold the same values, whatever their key order. */
export const sameLook = (a: Look, b: Look): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

/** The first 16 hex characters of the SHA-256 of the Look's canonical JSON. */
export const lookVersion = async (look: Look): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(look)))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ---------------------------------------------------------------------------
// Checking a Look from outside
// ---------------------------------------------------------------------------

const LOGO_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/webp',
  'image/svg+xml',
])
const FORMATS: ReadonlySet<string> = new Set(Object.keys(EXTENSIONS))
/** Letters, digits, spaces and a few marks; never quotes or brackets. */
export const FAMILY = /^[\p{L}\p{N} .\-_]{1,64}$/u
export const FACES_MAX = 500

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const checkFace = (face: unknown): FontFaceFile | null => {
  if (!isObject(face)) return null
  const { sha256, format, weight, style, unicodeRange } = face
  if (
    typeof sha256 !== 'string' ||
    !SHA256.test(sha256) ||
    typeof format !== 'string' ||
    !FORMATS.has(format) ||
    typeof weight !== 'string' ||
    !WEIGHT.test(weight) ||
    weight.split(' ').some((w) => Number(w) < 1 || Number(w) > 1000) ||
    (style !== 'normal' && style !== 'italic') ||
    (unicodeRange !== null &&
      (typeof unicodeRange !== 'string' ||
        unicodeRange.length > 2000 ||
        !UNICODE_RANGE.test(unicodeRange)))
  ) {
    return null
  }
  return {
    sha256,
    format: format as FontFaceFile['format'],
    weight,
    style,
    unicodeRange: unicodeRange as string | null,
  }
}

const checkFont = (choice: unknown): FontChoice | null => {
  if (!isObject(choice)) return null
  switch (choice.kind) {
    case 'agent964':
      return choice.face === undefined
        ? { kind: 'agent964' }
        : FONT_ROLES.includes(choice.face as FontRole)
          ? { kind: 'agent964', face: choice.face as FontRole }
          : null
    case 'system':
      return typeof choice.family === 'string' &&
        Object.hasOwn(SYSTEM_STACKS, choice.family)
        ? { kind: 'system', family: choice.family as SystemFamily }
        : null
    case 'google':
    case 'upload': {
      const { family, faces } = choice
      if (
        typeof family !== 'string' ||
        !FAMILY.test(family) ||
        !Array.isArray(faces) ||
        faces.length === 0 ||
        faces.length > FACES_MAX
      ) {
        return null
      }
      const checked = faces.map(checkFace)
      if (checked.some((face) => face === null)) return null
      return { kind: choice.kind, family, faces: checked as FontFaceFile[] }
    }
    default:
      return null
  }
}

const checkRole = (value: unknown): RoleValue | null => {
  if (!isObject(value)) return null
  if (typeof value.color === 'string') {
    return parseColor(value.color) === null ? null : { color: value.color }
  }
  if (typeof value.step !== 'string' || stepOf(value.step) === null) return null
  const step = value.step as StepName
  if (value.alpha === undefined) return { step }
  return typeof value.alpha === 'number' && value.alpha >= 0 && value.alpha <= 1
    ? { step, alpha: value.alpha }
    : null
}

/**
 * A Look from JSON, or what is wrong with it. Colours must parse, the name
 * fits, the radius is 0 to 24, and fonts and the logo are named by hash.
 */
export const checkLook = (
  value: unknown,
): { readonly look: Look } | { readonly problem: string } => {
  if (!isObject(value) || value.v !== 1)
    return { problem: 'This is not a Look.' }
  const { name, logo, palette, roles, fonts, radius } = value
  if (typeof name !== 'string' || [...name].length > NAME_MAX) {
    return { problem: `The name is at most ${NAME_MAX} characters.` }
  }
  if (
    logo !== null &&
    (!isObject(logo) ||
      typeof logo.sha256 !== 'string' ||
      !SHA256.test(logo.sha256) ||
      typeof logo.type !== 'string' ||
      !LOGO_TYPES.has(logo.type))
  ) {
    return { problem: 'The logo is not one this deployment holds.' }
  }
  if (!isObject(palette)) return { problem: 'The palette is missing.' }
  const checkedPalette = {} as Record<ScaleName, Record<Step, ColorText>>
  for (const scaleName of SCALES) {
    const steps = palette[scaleName]
    if (!isObject(steps)) {
      return { problem: `The ${scaleName} scale is missing.` }
    }
    checkedPalette[scaleName] = {} as Record<Step, ColorText>
    for (const step of STEPS) {
      const text = steps[String(step)]
      if (typeof text !== 'string' || parseColor(text) === null) {
        return {
          problem: `${scaleName}-${step} is not a colour. Write OKLCH, such as oklch(70% 0.2 0), or HEX, such as #ff7ab6.`,
        }
      }
      checkedPalette[scaleName][step] = text.trim()
    }
  }
  if (!isObject(roles)) return { problem: 'The roles are missing.' }
  const checkedRoles: Partial<Record<RoleName, RoleValue>> = {}
  for (const [role, roleValue] of Object.entries(roles)) {
    if (!ROLES.includes(role as RoleName)) {
      return { problem: `${role} is not a role.` }
    }
    const checked = checkRole(roleValue)
    if (checked === null)
      return { problem: `The ${role} role is not a colour.` }
    checkedRoles[role as RoleName] = checked
  }
  if (!isObject(fonts)) return { problem: 'The fonts are missing.' }
  const checkedFonts = {} as Record<FontRole, FontChoice>
  for (const role of FONT_ROLES) {
    const choice = checkFont(fonts[role])
    if (choice === null) {
      return {
        problem: `The ${ROLE_TITLES[role]} font is not one this deployment holds.`,
      }
    }
    checkedFonts[role] = choice
  }
  if (
    typeof radius !== 'number' ||
    !Number.isInteger(radius) ||
    radius < 0 ||
    radius > RADIUS_MAX
  ) {
    return { problem: `The corner radius is 0 to ${RADIUS_MAX} px.` }
  }
  return {
    look: {
      v: 1,
      name: name.trim(),
      logo:
        logo === null
          ? null
          : { sha256: logo.sha256 as string, type: logo.type as LogoType },
      palette: checkedPalette,
      roles: checkedRoles,
      fonts: checkedFonts,
      radius,
    },
  }
}

/** The name the header shows. */
export const headerName = (look: Pick<Look, 'name'>) =>
  look.name.trim() === '' ? 'Dossier' : look.name.trim()

/**
 * Every font file a Look names, with the format it names it in, and its
 * logo, for checking the deployment holds each as named.
 */
export const filesOf = (
  look: Look,
): {
  readonly fonts: readonly Pick<FontFaceFile, 'sha256' | 'format'>[]
  readonly logo: Look['logo']
} => {
  const fonts = new Map<string, Pick<FontFaceFile, 'sha256' | 'format'>>()
  for (const role of FONT_ROLES) {
    const choice = look.fonts[role]
    if (choice.kind !== 'google' && choice.kind !== 'upload') continue
    for (const { sha256, format } of choice.faces) {
      fonts.set(`${sha256}.${format}`, { sha256, format })
    }
  }
  return { fonts: [...fonts.values()], logo: look.logo }
}
