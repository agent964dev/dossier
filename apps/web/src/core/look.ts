import { dossierError, type DossierError } from '@dossier/contracts'
import { Context, Effect, Layer, Option } from 'effect'

import {
  AGENT964_LOOK,
  checkLook,
  contrastChecks,
  FAMILY,
  filesOf,
  lookCss,
  lookVersion,
  MIN_CONTRAST,
  ratioText,
  type FontChoice,
  type FontFaceFile,
  type Look,
  type LogoType,
} from '../lib/look.ts'
import { Bindings } from './bindings.ts'
import { CurrentCaller, type Caller } from './caller.ts'
import { People } from './people.ts'
import { settingsGeneration } from './settings.ts'

export interface LookState {
  readonly look: Look
  readonly version: string
  /** A super admin saved this Look; false means agent964's. */
  readonly custom: boolean
}

type Fail<C extends Parameters<typeof dossierError>[0]> = DossierError<C>

export interface LookSettingsService {
  /** One D1 read per screen request. */
  readonly current: () => Effect.Effect<LookState, Fail<'unavailable'>>
  /** The current version's stylesheet, or null for any other version. */
  readonly stylesheet: (
    version: string,
  ) => Effect.Effect<string | null, Fail<'unavailable'>>
  /** `<sha256>.<ext>` from R2, or null. */
  readonly font: (file: string) => Effect.Effect<{
    readonly body: ReadableStream<Uint8Array>
    readonly type: string
    readonly size: number
  } | null>
  readonly logo: (sha256: string) => Effect.Effect<{
    readonly body: ReadableStream<Uint8Array>
    readonly type: string
    readonly size: number
  } | null>
  /** Copies a Google Fonts family into R2; nothing changes until Save. */
  readonly fetchGoogleFont: (
    family: string,
  ) => Effect.Effect<
    Extract<FontChoice, { kind: 'google' }>,
    Fail<
      'sign_in_required' | 'not_found' | 'invalid' | 'too_large' | 'unavailable'
    >,
    CurrentCaller
  >
  readonly uploadFont: (i: {
    readonly family: string
    readonly bytes: Uint8Array
  }) => Effect.Effect<
    Extract<FontChoice, { kind: 'upload' }>,
    Fail<
      'sign_in_required' | 'not_found' | 'invalid' | 'too_large' | 'unavailable'
    >,
    CurrentCaller
  >
  readonly uploadLogo: (i: {
    readonly bytes: Uint8Array
  }) => Effect.Effect<
    NonNullable<Look['logo']>,
    Fail<
      'sign_in_required' | 'not_found' | 'invalid' | 'too_large' | 'unavailable'
    >,
    CurrentCaller
  >
  readonly save: (
    look: Look,
  ) => Effect.Effect<
    LookState,
    Fail<'sign_in_required' | 'not_found' | 'invalid' | 'unavailable'>,
    CurrentCaller
  >
  /** Removes the saved Look: agent964's again. */
  readonly reset: () => Effect.Effect<
    LookState,
    Fail<'sign_in_required' | 'not_found' | 'unavailable'>,
    CurrentCaller
  >
}

/** Super admin actions answer not_found for anyone else. */
export class LookSettings extends Context.Tag('LookSettings')<
  LookSettings,
  LookSettingsService
>() {}

const MiB = 1024 * 1024
/** Each font file, copied or uploaded. */
export const FONT_FILE_BYTES = 2 * MiB
/** Every file of one Google family together. */
export const FONT_FAMILY_BYTES = 20 * MiB
export const LOGO_BYTES = 512 * 1024

const GOOGLE_CSS = 'https://fonts.googleapis.com/css2'
const GOOGLE_FILES = 'https://fonts.gstatic.com/'
/** Google's stylesheet for one family, even one of many scripts, is far less. */
export const GOOGLE_CSS_BYTES = 512 * 1024
const MAX_REDIRECTS = 3
/** Google lists WOFF2 files only to browsers it knows read them. */
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const GOOGLE_FAMILY = /^[A-Za-z0-9 ]{1,64}$/
const AXES = 'ital,wght@0,400;0,500;0,600;0,700;1,400'

const FONT_TYPES: Readonly<Record<FontFaceFile['format'], string>> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  truetype: 'font/ttf',
  opentype: 'font/otf',
}
const FORMAT_OF_EXT: Readonly<Record<string, FontFaceFile['format']>> = {
  woff2: 'woff2',
  woff: 'woff',
  ttf: 'truetype',
  otf: 'opentype',
}

/** The format() names of @font-face. */
const FORMAT_OF_TOKEN: Readonly<Record<string, FontFaceFile['format']>> = {
  woff2: 'woff2',
  woff: 'woff',
  truetype: 'truetype',
  opentype: 'opentype',
}

const starts = (bytes: Uint8Array, text: string, at = 0) =>
  [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0))

/** A font's format by its first bytes, or null. */
export const fontFormatOf = (
  bytes: Uint8Array,
): FontFaceFile['format'] | null => {
  if (starts(bytes, 'wOF2')) return 'woff2'
  if (starts(bytes, 'wOFF')) return 'woff'
  if (starts(bytes, 'OTTO')) return 'opentype'
  if (
    starts(bytes, 'true') ||
    (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)
  ) {
    return 'truetype'
  }
  return null
}

const SVG_START =
  /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE\s+svg[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i

/** A logo's type by its first bytes, or null. */
export const logoTypeOf = (bytes: Uint8Array): LogoType | null => {
  if (starts(bytes, '\x89PNG\r\n\x1a\n')) return 'image/png'
  if (starts(bytes, 'RIFF') && starts(bytes, 'WEBP', 8)) return 'image/webp'
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 4096))
    .replace(/^﻿/, '')
  return SVG_START.test(head) ? 'image/svg+xml' : null
}

const sha256Of = async (bytes: Uint8Array): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

interface GoogleFace {
  readonly url: string
  readonly format: FontFaceFile['format']
  readonly weight: string
  readonly style: 'normal' | 'italic'
  readonly unicodeRange: string | null
}

/** Each @font-face of Google's stylesheet whose file is on fonts.gstatic.com. */
export const googleFaces = (css: string): readonly GoogleFace[] => {
  const faces: GoogleFace[] = []
  for (const block of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = block[1] ?? ''
    const read = (name: string) =>
      new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i')
        .exec(body)?.[1]
        ?.trim() ?? null
    const src = read('src') ?? ''
    const url = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/.exec(src)?.[1]
    if (url === undefined || !url.startsWith(GOOGLE_FILES)) continue
    const token = /format\(\s*['"]?([a-z0-9]+)/i.exec(src)?.[1] ?? 'woff2'
    const key = token.toLowerCase()
    if (!Object.hasOwn(FORMAT_OF_TOKEN, key)) continue
    const format = FORMAT_OF_TOKEN[key]!
    const style = read('font-style') === 'italic' ? 'italic' : 'normal'
    const weight = (read('font-weight') ?? '400').replace(/\s+/g, ' ')
    faces.push({
      url,
      format,
      weight,
      style,
      unicodeRange: read('unicode-range')?.replace(/\s+/g, ' ') ?? null,
    })
  }
  return faces
}

export const LookSettingsLive: Layer.Layer<
  LookSettings,
  never,
  Bindings | People
> = Layer.effect(
  LookSettings,
  Effect.gen(function* () {
    const { DB, BLOBS } = yield* Bindings
    const people = yield* People

    let defaultState: Promise<LookState> | undefined
    const agent964 = () =>
      (defaultState ??= lookVersion(AGENT964_LOOK).then((version) => ({
        look: AGENT964_LOOK,
        version,
        custom: false,
      })))

    const unavailable = (what: string) => (error: unknown) => {
      console.error(what, error)
      return dossierError('unavailable')
    }

    const read = Effect.gen(function* () {
      const row = yield* Effect.tryPromise({
        try: () =>
          DB.prepare(
            "select value_json as valueJson from deployment_settings where key = 'look'",
          ).first<{ valueJson: string }>(),
        catch: unavailable('Reading the Look failed'),
      })
      if (row !== null) {
        let saved: unknown = null
        try {
          saved = (JSON.parse(row.valueJson) as { look?: unknown }).look
        } catch {
          saved = null
        }
        const checked = checkLook(saved)
        if ('look' in checked) {
          const version = yield* Effect.promise(() => lookVersion(checked.look))
          return { look: checked.look, version, custom: true }
        }
        console.error('The saved Look does not read; agent964 is shown', {
          problem: checked.problem,
        })
      }
      return yield* Effect.promise(agent964)
    })

    const cache = new WeakMap<
      Caller,
      { readonly generation: number; readonly value: LookState }
    >()

    const current: LookSettingsService['current'] = () =>
      Effect.gen(function* () {
        const caller = Option.getOrNull(
          yield* Effect.serviceOption(CurrentCaller),
        )
        const cached = caller === null ? undefined : cache.get(caller)
        if (
          cached !== undefined &&
          cached.generation === settingsGeneration()
        ) {
          return cached.value
        }
        const at = settingsGeneration()
        const value = yield* read
        if (caller !== null) cache.set(caller, { generation: at, value })
        return value
      })

    const stylesheet: LookSettingsService['stylesheet'] = (version) =>
      Effect.map(current(), (state) =>
        state.version === version ? lookCss(state.look) : null,
      )

    const object = (key: string) =>
      Effect.tryPromise(() => BLOBS.get(key)).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() => {
            console.error('Reading a Look file failed', { key, error })
            return null
          }),
        ),
      )

    const font: LookSettingsService['font'] = (file) =>
      Effect.gen(function* () {
        const match = /^([0-9a-f]{64})\.(woff2|woff|ttf|otf)$/.exec(file)
        if (match === null) return null
        const found = yield* object(`fonts/${match[1]}`)
        if (found === null) return null
        const format = FORMAT_OF_EXT[match[2]!]!
        // The file answers only under the name its own format gives it.
        if (found.customMetadata?.format !== format) {
          yield* Effect.promise(() => found.body.cancel())
          return null
        }
        return { body: found.body, type: FONT_TYPES[format], size: found.size }
      })

    const logo: LookSettingsService['logo'] = (sha256) =>
      Effect.gen(function* () {
        if (!/^[0-9a-f]{64}$/.test(sha256)) return null
        const found = yield* object(`looks/${sha256}`)
        if (found === null) return null
        return {
          body: found.body,
          type: found.httpMetadata?.contentType ?? 'application/octet-stream',
          size: found.size,
        }
      })

    /** Stores a file under its hash once; a second copy writes nothing. */
    const keep = (
      key: string,
      bytes: Uint8Array,
      type: string,
      meta: Record<string, string>,
    ) =>
      Effect.tryPromise({
        try: async () => {
          if ((await BLOBS.head(key)) !== null) return
          await BLOBS.put(key, bytes, {
            httpMetadata: { contentType: type },
            customMetadata: meta,
          })
        },
        catch: unavailable('Storing a Look file failed'),
      })

    const tooLargeFont = () =>
      dossierError('too_large', 'A font file is at most 2 MiB.')
    const tooLargeFamily = () =>
      dossierError(
        'too_large',
        'This family is more than 20 MiB of font files. Upload the faces you need instead.',
      )
    const googleDown = () =>
      dossierError('unavailable', 'Google Fonts did not answer. Try again.')

    /**
     * A GET to one of Google's hosts. Redirects are followed by hand, at
     * most three, and only while they stay on that host over HTTPS.
     */
    const fromGoogle = (url: string, headers: Record<string, string>) =>
      Effect.tryPromise({
        try: async () => {
          let at = new URL(url)
          const host = at.host
          for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
            if (at.protocol !== 'https:' || at.host !== host) {
              console.error('Google Fonts redirected off its host', {
                from: url,
                to: at.href,
              })
              throw new Error('redirected off Google')
            }
            const response = await fetch(at.href, {
              headers,
              redirect: 'manual',
            })
            const location = response.headers.get('location')
            if (
              response.status < 300 ||
              response.status >= 400 ||
              location === null
            ) {
              return response
            }
            await response.body?.cancel()
            at = new URL(location, at)
          }
          throw new Error('too many redirects')
        },
        catch: googleDown,
      })

    /**
     * The body, read only up to `limit` bytes: past it the stream is
     * cancelled and `tooLarge` answers, whatever length Google declared.
     */
    const readUpTo = <E>(
      response: Response,
      limit: number,
      tooLarge: () => E,
    ): Effect.Effect<Uint8Array, E | ReturnType<typeof googleDown>> =>
      Effect.tryPromise({
        try: async () => {
          const declared = Number(response.headers.get('content-length') ?? NaN)
          if (declared > limit) {
            await response.body?.cancel()
            return null
          }
          if (response.body === null) return new Uint8Array(0)
          const reader = response.body.getReader()
          const chunks: Uint8Array[] = []
          let total = 0
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > limit) {
              await reader.cancel()
              return null
            }
            chunks.push(value)
          }
          const bytes = new Uint8Array(total)
          let at = 0
          for (const chunk of chunks) {
            bytes.set(chunk, at)
            at += chunk.byteLength
          }
          return bytes
        },
        catch: googleDown,
      }).pipe(
        Effect.flatMap((bytes) =>
          bytes === null ? Effect.fail(tooLarge()) : Effect.succeed(bytes),
        ),
      )

    const download = (url: string, budget: { left: number }) =>
      Effect.gen(function* () {
        const response = yield* fromGoogle(url, { 'user-agent': CHROME })
        if (!response.ok) {
          yield* Effect.promise(async () => response.body?.cancel())
          return yield* Effect.fail(googleDown())
        }
        // Never more than the file limit, nor than the family has left.
        const limit = Math.min(FONT_FILE_BYTES, budget.left)
        const bytes = yield* readUpTo(response, limit, () =>
          limit < FONT_FILE_BYTES ? tooLargeFamily() : tooLargeFont(),
        )
        budget.left -= bytes.byteLength
        return bytes
      })

    const googleCss = (query: string) =>
      fromGoogle(`${GOOGLE_CSS}?${query}`, {
        'user-agent': CHROME,
        accept: 'text/css',
      })

    const fetchGoogleFont: LookSettingsService['fetchGoogleFont'] = (input) =>
      Effect.gen(function* () {
        yield* people.superAdminOnly()
        const family = input.trim().replace(/\s+/g, ' ')
        if (!GOOGLE_FAMILY.test(family)) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              'A Google Fonts family is 1 to 64 letters, digits and spaces, such as Inter or Noto Sans Arabic.',
              null,
              'family',
            ),
          )
        }
        const name = family.replaceAll(' ', '+')
        let response = yield* googleCss(`family=${name}:${AXES}&display=swap`)
        // A family without every weight or italics refuses the axes.
        if (response.status === 400) {
          yield* Effect.promise(async () => response.body?.cancel())
          response = yield* googleCss(`family=${name}&display=swap`)
        }
        if (response.status === 400) {
          yield* Effect.promise(async () => response.body?.cancel())
          return yield* Effect.fail(
            dossierError(
              'invalid',
              `Google Fonts has no family named "${family}".`,
              null,
              'family',
            ),
          )
        }
        if (!response.ok) {
          yield* Effect.promise(async () => response.body?.cancel())
          return yield* Effect.fail(
            dossierError(
              'unavailable',
              'Google Fonts did not answer. Try again.',
            ),
          )
        }
        const css = new TextDecoder().decode(
          yield* readUpTo(response, GOOGLE_CSS_BYTES, () =>
            dossierError(
              'too_large',
              `Google Fonts sent more for "${family}" than this deployment reads.`,
            ),
          ),
        )
        const faces = googleFaces(css)
        if (faces.length === 0) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              `Google Fonts has no family named "${family}".`,
              null,
              'family',
            ),
          )
        }
        const budget = { left: FONT_FAMILY_BYTES }
        const files = new Map<string, string>()
        for (const url of new Set(faces.map((face) => face.url))) {
          const bytes = yield* download(url, budget)
          const format = fontFormatOf(bytes)
          if (format === null) {
            return yield* Effect.fail(
              dossierError(
                'unavailable',
                'Google Fonts sent a file that is not a font.',
              ),
            )
          }
          const sha256 = yield* Effect.promise(() => sha256Of(bytes))
          yield* keep(`fonts/${sha256}`, bytes, FONT_TYPES[format], { format })
          files.set(url, `${sha256}:${format}`)
        }
        return {
          kind: 'google' as const,
          family,
          faces: faces.slice(0, 500).map((face) => {
            const [sha256, format] = files.get(face.url)!.split(':') as [
              string,
              FontFaceFile['format'],
            ]
            return {
              sha256,
              format,
              weight: face.weight,
              style: face.style,
              unicodeRange: face.unicodeRange,
            }
          }),
        }
      })

    const uploadFont: LookSettingsService['uploadFont'] = ({ family, bytes }) =>
      Effect.gen(function* () {
        yield* people.superAdminOnly()
        const name = family.trim().replace(/\s+/g, ' ')
        if (!FAMILY.test(name)) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              'Name the font in 1 to 64 letters, digits and spaces.',
              null,
              'family',
            ),
          )
        }
        if (bytes.byteLength > FONT_FILE_BYTES) {
          return yield* Effect.fail(tooLargeFont())
        }
        const format = fontFormatOf(bytes)
        if (format === null) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              'This file is not a font. Upload WOFF2, WOFF, TTF or OTF.',
              null,
              'file',
            ),
          )
        }
        const sha256 = yield* Effect.promise(() => sha256Of(bytes))
        yield* keep(`fonts/${sha256}`, bytes, FONT_TYPES[format], { format })
        return {
          kind: 'upload' as const,
          family: name,
          faces: [
            // One file stands for every weight, so text is never made bold
            // by the browser from a face it does not hold.
            {
              sha256,
              format,
              weight: '100 900',
              style: 'normal',
              unicodeRange: null,
            },
          ],
        }
      })

    const uploadLogo: LookSettingsService['uploadLogo'] = ({ bytes }) =>
      Effect.gen(function* () {
        yield* people.superAdminOnly()
        if (bytes.byteLength > LOGO_BYTES) {
          return yield* Effect.fail(
            dossierError('too_large', 'A logo is at most 512 KiB.'),
          )
        }
        const type = logoTypeOf(bytes)
        if (type === null) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              'This file is not a logo. Upload PNG, WebP or SVG.',
              null,
              'file',
            ),
          )
        }
        const sha256 = yield* Effect.promise(() => sha256Of(bytes))
        yield* keep(`looks/${sha256}`, bytes, type, {})
        return { sha256, type }
      })

    /** The deployment holds the file, as the format or type the Look names. */
    const storedAs = (key: string, holds: (found: R2Object) => boolean) =>
      Effect.tryPromise({
        try: async () => {
          const found = await BLOBS.head(key)
          return found !== null && holds(found)
        },
        catch: unavailable('Checking a Look file failed'),
      })

    const save: LookSettingsService['save'] = (input) =>
      Effect.gen(function* () {
        yield* people.superAdminOnly()
        const checked = checkLook(input)
        if ('problem' in checked) {
          return yield* Effect.fail(dossierError('invalid', checked.problem))
        }
        const { look } = checked
        const low = contrastChecks(look).find((check) => !check.ok)
        if (low !== undefined) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              `${low.pair} is ${ratioText(low.ratio)} (${low.worst}); it needs at least ${MIN_CONTRAST}:1.`,
            ),
          )
        }
        const files = filesOf(look)
        const present = yield* Effect.all(
          [
            ...files.fonts.map(({ sha256, format }) =>
              storedAs(
                `fonts/${sha256}`,
                (found) => found.customMetadata?.format === format,
              ),
            ),
            ...(files.logo === null
              ? []
              : [
                  storedAs(
                    `looks/${files.logo.sha256}`,
                    (found) =>
                      found.httpMetadata?.contentType === files.logo?.type,
                  ),
                ]),
          ],
          { concurrency: 6 },
        )
        if (present.some((found) => !found)) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              'A font or the logo of this Look is not on this deployment as named. Fetch or upload it again.',
            ),
          )
        }
        const version = yield* Effect.promise(() => lookVersion(look))
        yield* people
          .saveSetting('look', { look, version })
          .pipe(
            Effect.catchTag('DossierError', (error) =>
              error.code === 'forbidden'
                ? Effect.fail(dossierError('not_found'))
                : Effect.fail(
                    error as Fail<
                      'sign_in_required' | 'not_found' | 'unavailable'
                    >,
                  ),
            ),
          )
        return { look, version, custom: true }
      })

    const reset: LookSettingsService['reset'] = () =>
      Effect.gen(function* () {
        yield* people.superAdminOnly()
        yield* people
          .saveSetting('look', null)
          .pipe(
            Effect.catchTag('DossierError', (error) =>
              error.code === 'forbidden'
                ? Effect.fail(dossierError('not_found'))
                : Effect.fail(
                    error as Fail<
                      'sign_in_required' | 'not_found' | 'unavailable'
                    >,
                  ),
            ),
          )
        return yield* Effect.promise(agent964)
      })

    return {
      current,
      stylesheet,
      font,
      logo,
      fetchGoogleFont,
      uploadFont,
      uploadLogo,
      save,
      reset,
    } satisfies LookSettingsService
  }),
)
