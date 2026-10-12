import type { Person, TreeId } from '@dossier/contracts'
import { SELF } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  LookSettings,
  type Caller,
  type CommitResult,
  type CurrentCaller,
  type LookSettingsService,
  type StageResult,
} from '../src/core/index.ts'
import {
  AGENT964_LOOK,
  lookVersion,
  PRESETS,
  type FontChoice,
  type Look,
} from '../src/lib/look.ts'
import { signedIn, type Browser } from './support/browser.ts'
import { exec } from './support/d1.ts'
import { harness, testRuntime } from './support/harness.ts'
import { callerOf, fresh, runAs, sessionFor } from './support/people.ts'
import {
  agent,
  failureAs,
  join,
  person,
  pushAll,
  superAdmin,
  workspace,
} from './support/trees.ts'

const MAIN = 'https://dossier.test'

const get = (url: string, init: RequestInit = {}) =>
  SELF.fetch(url, { redirect: 'manual', ...init })

const look = <A, E>(
  caller: Caller,
  use: (l: LookSettingsService) => Effect.Effect<A, E, CurrentCaller>,
) => runAs(caller, Effect.flatMap(LookSettings, use))

const lookFailure = <A, E>(
  caller: Caller,
  use: (l: LookSettingsService) => Effect.Effect<A, E, CurrentCaller>,
) => failureAs(caller, Effect.flatMap(LookSettings, use))

/** Bytes that start like a WOFF2 file, distinct per name. */
const woff2 = (name: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(`wOF2\u0000\u0001${name.padEnd(64, '.')}`)

// ---------------------------------------------------------------------------
// A stand-in for Google Fonts inside the test isolate: fetch is replaced for
// fonts.googleapis.com and fonts.gstatic.com only.
// ---------------------------------------------------------------------------

const googleLog: string[] = []
/** Requests that left Google's hosts by following a redirect. */
const elsewhereLog: string[] = []
const FILES: Record<string, Uint8Array<ArrayBuffer>> = {
  'inter-latin.woff2': woff2('inter-latin'),
  'inter-latin-ext.woff2': woff2('inter-latin-ext'),
  'pacifico.woff2': woff2('pacifico'),
}

const MiB = 1024 * 1024
const CHUNK = 64 * 1024
/** Bytes each streamed answer has handed out so far, by name. */
const pulled: Record<string, number> = {}

/** A body with no Content-Length that hands out `total` bytes on demand. */
const streamed = (name: string, total: number, head: string) => {
  pulled[name] = 0
  const first = new TextEncoder().encode(head)
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const sent = pulled[name]!
      if (sent >= total) {
        controller.close()
        return
      }
      const size = Math.min(CHUNK, total - sent)
      const chunk = new Uint8Array(size).fill(0x20)
      if (sent === 0) chunk.set(first.subarray(0, size))
      pulled[name] = sent + size
      controller.enqueue(chunk)
    },
  })
}

const face = (style: string, weight: number, file: string, range: string) => `
/* subset */
@font-face {
  font-family: 'X';
  font-style: ${style};
  font-weight: ${weight};
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/x/${file}) format('woff2');
  unicode-range: ${range};
}`

const cssAnswer = (text: string) =>
  new Response(text, { headers: { 'content-type': 'text/css' } })

const googleCss = (query: URLSearchParams): Response => {
  const family = query.get('family') ?? ''
  const name = family.split(':')[0]
  if (family.startsWith('Inter:')) {
    // A variable family: every weight points at the same two files.
    return cssAnswer(
      [400, 500, 600, 700]
        .flatMap((weight) => [
          face('normal', weight, 'inter-latin-ext.woff2', 'U+0100-02BA'),
          face('normal', weight, 'inter-latin.woff2', 'U+0000-00FF'),
        ])
        .join('\n'),
    )
  }
  // A family with one face refuses the axes, and answers by name alone.
  if (family === 'Pacifico') {
    return cssAnswer(face('normal', 400, 'pacifico.woff2', 'U+0000-00FF'))
  }
  switch (name) {
    case 'Endless':
      return cssAnswer(face('normal', 400, 'endless.woff2', 'U+0000-00FF'))
    case 'Bigcss':
      // A stylesheet of 3 MiB, sent without a length.
      return new Response(
        streamed(
          'bigcss',
          3 * MiB,
          face('normal', 400, 'inter-latin.woff2', 'U+0000-00FF') + '\n/*',
        ),
        { headers: { 'content-type': 'text/css' } },
      )
    case 'Many':
      // Eleven faces of 1.9 MiB each: more than a family may hold.
      return cssAnswer(
        Array.from({ length: 11 }, (_, i) =>
          face(
            'normal',
            400,
            `many-${i}.woff2`,
            `U+${(i * 256).toString(16).padStart(4, '0')}-${(i * 256 + 255).toString(16).padStart(4, '0')}`,
          ),
        ).join('\n'),
      )
    case 'Hop':
      return cssAnswer(face('normal', 400, 'hop.woff2', 'U+0000-00FF'))
    case 'Inside':
      return cssAnswer(face('normal', 400, 'inside.woff2', 'U+0000-00FF'))
    case 'Moved':
      return new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example/css2?family=Moved' },
      })
  }
  return new Response('Bad Request', { status: 400 })
}

const googleFile = (file: string): Response => {
  if (file === 'endless.woff2') {
    return new Response(streamed('endless', 50 * MiB, 'wOF2'), {
      headers: { 'content-type': 'font/woff2' },
    })
  }
  const many = /^many-(\d+)\.woff2$/.exec(file)
  if (many !== null) {
    return new Response(
      streamed(`many-${many[1]}`, 1.9 * MiB, `wOF2${many[1]}`),
      { headers: { 'content-type': 'font/woff2' } },
    )
  }
  if (file === 'hop.woff2') {
    return new Response(null, {
      status: 302,
      headers: { location: 'https://elsewhere.example/hop.woff2' },
    })
  }
  if (file === 'inside.woff2') {
    return new Response(null, {
      status: 302,
      headers: { location: 'https://fonts.gstatic.com/s/x/inter-latin.woff2' },
    })
  }
  const bytes = FILES[file]
  return bytes === undefined
    ? new Response('Not found', { status: 404 })
    : new Response(bytes, { headers: { 'content-type': 'font/woff2' } })
}

/** One hop: Google's hosts answer as above, any other host as an attacker would. */
const answer = (url: URL): Response | null => {
  if (url.host === 'fonts.googleapis.com') {
    googleLog.push(url.href)
    return googleCss(url.searchParams)
  }
  if (url.host === 'fonts.gstatic.com') {
    googleLog.push(url.href)
    return googleFile(url.pathname.split('/').pop() ?? '')
  }
  if (url.host.endsWith('.example')) {
    elsewhereLog.push(url.href)
    return new Response(woff2('elsewhere'), {
      headers: { 'content-type': 'font/woff2' },
    })
  }
  return null
}

const realFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
    )
    const mode = init?.redirect ?? 'follow'
    // Redirects are followed, refused or handed back as fetch itself does.
    for (let hop = 0; hop < 10; hop += 1) {
      const response = answer(url)
      if (response === null) return realFetch(input, init)
      const location = response.headers.get('location')
      if (
        response.status < 300 ||
        response.status >= 400 ||
        location === null
      ) {
        return response
      }
      if (mode === 'manual') return response
      if (mode === 'error') throw new TypeError('redirect refused')
      url = new URL(location, url)
    }
    throw new TypeError('too many redirects')
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
})
afterEach(() => harness.reset())

/** R2 with every put recorded. */
const recordingBlobs = () => {
  const puts: string[] = []
  const blobs = new Proxy(env.BLOBS, {
    get(target, prop, receiver) {
      if (prop === 'put') {
        return (key: string, ...rest: unknown[]) => {
          puts.push(key)
          return (target.put as (...a: unknown[]) => unknown).call(
            target,
            key,
            ...rest,
          )
        }
      }
      const value = Reflect.get(target, prop, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { blobs, puts }
}

let chief: Person
let admin: Caller
let member: Caller
let wsAdmin: Caller

beforeAll(async () => {
  await exec("delete from deployment_settings where key = 'look'")
  chief = await person('chief')
  await superAdmin(chief)
  admin = await sessionFor(chief)
  const owner = await person('owner')
  const ws = await workspace(owner)
  wsAdmin = await sessionFor(owner)
  const someone = await person('member')
  await join(ws, someone)
  member = await sessionFor(someone)
})

const SVG = new TextEncoder().encode(
  '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
)

describe('who may change the Look', () => {
  it('answers not_found to a member, a workspace admin and an agent key, for every action', async () => {
    const key = await agent(chief)
    for (const caller of [member, wsAdmin, key]) {
      const failures = [
        await lookFailure(caller, (l) => l.fetchGoogleFont('Inter')),
        await lookFailure(caller, (l) =>
          l.uploadFont({ family: 'X', bytes: woff2('x') }),
        ),
        await lookFailure(caller, (l) => l.uploadLogo({ bytes: SVG })),
        await lookFailure(caller, (l) => l.save(PRESETS.Studio)),
        await lookFailure(caller, (l) => l.reset()),
      ]
      expect(failures.map((f) => f.code)).toEqual(Array(5).fill('not_found'))
    }
    // Nothing reached Google for them.
    expect(googleLog).toEqual([])
  })
})

describe('saving and resetting', () => {
  it('saves a Look and resets it, the version changing each time', async () => {
    const before = await look(admin, (l) => l.current())
    expect(before.custom).toBe(false)
    expect(before.version).toBe(await lookVersion(AGENT964_LOOK))

    const saved = await look(admin, (l) => l.save(PRESETS.Studio))
    expect(saved.custom).toBe(true)
    expect(saved.version).not.toBe(before.version)
    // A fresh request reads the saved Look.
    const next = await sessionFor(chief)
    expect((await look(next, (l) => l.current())).version).toBe(saved.version)

    const again = await look(admin, (l) =>
      l.save({ ...PRESETS.Studio, radius: 4 }),
    )
    expect(again.version).not.toBe(saved.version)

    const reset = await look(admin, (l) => l.reset())
    expect(reset).toMatchObject({ custom: false, version: before.version })
    expect(
      (await look(await sessionFor(chief), (l) => l.current())).custom,
    ).toBe(false)
  })

  it('refuses a Look whose text on background is 3:1, naming the pair', async () => {
    const low: Look = {
      ...AGENT964_LOOK,
      roles: { ...AGENT964_LOOK.roles, foreground: { color: '#5a6670' } },
    }
    const failure = await lookFailure(admin, (l) => l.save(low))
    expect(failure.code).toBe('invalid')
    expect(failure.message).toMatch(
      /^Text on background is 3\.\d:1 \(foreground on background\); it needs at least 4\.5:1\.$/,
    )
  })

  it('refuses a colour that is neither OKLCH nor HEX, and a font it does not hold', async () => {
    const named = structuredClone(AGENT964_LOOK) as unknown as {
      palette: Record<string, Record<string, string>>
    }
    named.palette.brand!['300'] = 'cyan'
    expect(
      (await lookFailure(admin, (l) => l.save(named as unknown as Look))).code,
    ).toBe('invalid')
    const missing: Look = {
      ...AGENT964_LOOK,
      fonts: {
        ...AGENT964_LOOK.fonts,
        body: {
          kind: 'upload',
          family: 'Nowhere',
          faces: [
            {
              sha256: 'f'.repeat(64),
              format: 'woff2',
              weight: '400',
              style: 'normal',
              unicodeRange: null,
            },
          ],
        },
      },
    }
    expect(
      (await lookFailure(admin, (l) => l.save(missing))).message,
    ).toContain('not on this deployment')
  })
})

describe('fonts from Google Fonts', () => {
  it('copies a family into R2 once; fetching it again writes nothing new', async () => {
    const { blobs, puts } = recordingBlobs()
    harness.use(testRuntime({ env: { BLOBS: blobs } }))
    googleLog.length = 0
    const first = await look(admin, (l) => l.fetchGoogleFont('Inter'))
    expect(first.family).toBe('Inter')
    expect(first.faces).toHaveLength(8)
    expect(new Set(first.faces.map((f) => f.sha256)).size).toBe(2)
    expect(first.faces[0]).toMatchObject({
      format: 'woff2',
      weight: '400',
      style: 'normal',
      unicodeRange: 'U+0100-02BA',
    })
    expect(puts.filter((key) => key.startsWith('fonts/'))).toHaveLength(2)
    // The stylesheet was asked for with every axis, and each file once.
    expect(googleLog[0]).toContain(
      'family=Inter:ital,wght@0,400;0,500;0,600;0,700;1,400',
    )
    expect(googleLog.filter((u) => u.includes('gstatic'))).toHaveLength(2)

    const second = await look(admin, (l) => l.fetchGoogleFont('Inter'))
    expect(second).toEqual(first)
    expect(puts.filter((key) => key.startsWith('fonts/'))).toHaveLength(2)

    // The copied family saves, since its files are on the deployment.
    const saved = await look(admin, (l) =>
      l.save({
        ...AGENT964_LOOK,
        fonts: { ...AGENT964_LOOK.fonts, body: first },
      }),
    )
    expect(saved.custom).toBe(true)
    await look(admin, (l) => l.reset())
  })

  it('asks again by name alone when a family refuses the axes', async () => {
    googleLog.length = 0
    const font = await look(admin, (l) => l.fetchGoogleFont('Pacifico'))
    expect(font.faces).toHaveLength(1)
    expect(googleLog.filter((u) => u.includes('googleapis'))).toEqual([
      expect.stringContaining('family=Pacifico:ital'),
      'https://fonts.googleapis.com/css2?family=Pacifico&display=swap',
    ])
  })

  it('answers invalid for a family Google Fonts does not have', async () => {
    const failure = await lookFailure(admin, (l) =>
      l.fetchGoogleFont('No Such Family'),
    )
    expect(failure.code).toBe('invalid')
    expect(failure.message).toBe(
      'Google Fonts has no family named "No Such Family".',
    )
    const odd = await lookFailure(admin, (l) =>
      l.fetchGoogleFont('Inter"; @import'),
    )
    expect(odd.code).toBe('invalid')
  })
})

describe('what Google may send', () => {
  it('stops reading a font file past 2 MiB even when Google names no length', async () => {
    const failure = await lookFailure(admin, (l) =>
      l.fetchGoogleFont('Endless'),
    )
    expect(failure.code).toBe('too_large')
    expect(pulled.endless!).toBeLessThanOrEqual(2 * MiB + 2 * CHUNK)
  })

  it('stops reading a stylesheet past its limit', async () => {
    const failure = await lookFailure(admin, (l) => l.fetchGoogleFont('Bigcss'))
    expect(failure.code).toBe('too_large')
    expect(pulled.bigcss!).toBeLessThanOrEqual(MiB)
  })

  it('stops at the family budget, never reading a file past it', async () => {
    const failure = await lookFailure(admin, (l) => l.fetchGoogleFont('Many'))
    expect(failure.code).toBe('too_large')
    const total = Object.entries(pulled)
      .filter(([name]) => name.startsWith('many-'))
      .reduce((sum, [, bytes]) => sum + bytes, 0)
    expect(total).toBeLessThanOrEqual(20 * MiB + 2 * CHUNK)
  })

  it('never follows a redirect off Google, for a stylesheet or a file', async () => {
    elsewhereLog.length = 0
    const moved = await lookFailure(admin, (l) => l.fetchGoogleFont('Moved'))
    expect(moved.code).toBe('unavailable')
    const hop = await lookFailure(admin, (l) => l.fetchGoogleFont('Hop'))
    expect(hop.code).toBe('unavailable')
    expect(elsewhereLog).toEqual([])
  })

  it('follows a redirect that stays on Google', async () => {
    const font = await look(admin, (l) => l.fetchGoogleFont('Inside'))
    expect(font.faces).toHaveLength(1)
  })
})

describe('uploads', () => {
  it('refuses a file without a font signature, and keeps a WOFF2', async () => {
    const refused = await lookFailure(admin, (l) =>
      l.uploadFont({
        family: 'Fake',
        bytes: new TextEncoder().encode('<html>not a font</html>'),
      }),
    )
    expect(refused.code).toBe('invalid')
    const kept = await look(admin, (l) =>
      l.uploadFont({ family: 'House Sans', bytes: woff2('house') }),
    )
    expect(kept).toMatchObject({
      kind: 'upload',
      family: 'House Sans',
      faces: [{ format: 'woff2', weight: '100 900', style: 'normal' }],
    })
  })

  it('refuses a Look that names a stored file in another format or type', async () => {
    const kept = await look(admin, (l) =>
      l.uploadFont({ family: 'Format Sans', bytes: woff2('format') }),
    )
    const asOpenType: Look = {
      ...AGENT964_LOOK,
      fonts: {
        ...AGENT964_LOOK.fonts,
        body: {
          ...kept,
          faces: kept.faces.map((f) => ({ ...f, format: 'opentype' as const })),
        },
      },
    }
    const failure = await lookFailure(admin, (l) => l.save(asOpenType))
    expect(failure.code).toBe('invalid')
    const logo = await look(admin, (l) => l.uploadLogo({ bytes: SVG }))
    const asPng: Look = {
      ...AGENT964_LOOK,
      logo: { sha256: logo.sha256, type: 'image/png' },
    }
    expect((await lookFailure(admin, (l) => l.save(asPng))).code).toBe(
      'invalid',
    )
  })

  it('refuses a font past 2 MiB and a logo that is not PNG, WebP or SVG', async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1)
    big.set(woff2('big'))
    expect(
      (
        await lookFailure(admin, (l) =>
          l.uploadFont({ family: 'Big', bytes: big }),
        )
      ).code,
    ).toBe('too_large')
    expect(
      (
        await lookFailure(admin, (l) =>
          l.uploadLogo({ bytes: new TextEncoder().encode('GIF89a') }),
        )
      ).code,
    ).toBe('invalid')
  })
})

describe('what the edge serves', () => {
  let font: Extract<FontChoice, { kind: 'upload' }>
  let logo: NonNullable<Look['logo']>
  let version: string
  let earlier: string

  beforeAll(async () => {
    font = await look(admin, (l) =>
      l.uploadFont({ family: 'Edge Sans', bytes: woff2('edge') }),
    )
    logo = await look(admin, (l) => l.uploadLogo({ bytes: SVG }))
    earlier = (await look(admin, (l) => l.save(PRESETS.Acme))).version
    version = (
      await look(admin, (l) =>
        l.save({
          ...PRESETS.Studio,
          logo,
          fonts: { ...PRESETS.Studio.fonts, display: font },
        }),
      )
    ).version
  })

  afterAll(async () => {
    await look(admin, (l) => l.reset())
  })

  const expectImmutable = (response: Response) => {
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    )
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.getSetCookie()).toEqual([])
  }

  it('serves a font by its hash as font/woff2, only under its own extension', async () => {
    const sha = font.faces[0]!.sha256
    const response = await get(`${MAIN}/_/fonts/${sha}.woff2`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('font/woff2')
    expectImmutable(response)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(woff2('edge'))
    expect((await get(`${MAIN}/_/fonts/${sha}.ttf`)).status).toBe(404)
    expect((await get(`${MAIN}/_/fonts/${'0'.repeat(64)}.woff2`)).status).toBe(
      404,
    )
  })

  it('serves the current stylesheet as immutable CSS and an older version as 404', async () => {
    const response = await get(`${MAIN}/_/look/${version}.css`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expectImmutable(response)
    const css = await response.text()
    expect(css).toContain('--brand-300: #ff7ab6;')
    expect(css).toContain(`url("/_/fonts/${font.faces[0]!.sha256}.woff2")`)
    expect(css).not.toMatch(/googleapis|gstatic/)
    expect((await get(`${MAIN}/_/look/${earlier}.css`)).status).toBe(404)
    const agent964 = await lookVersion(AGENT964_LOOK)
    expect((await get(`${MAIN}/_/look/${agent964}.css`)).status).toBe(404)
  })

  it('serves an SVG logo with its type and a sandbox that runs nothing', async () => {
    const response = await get(`${MAIN}/_/look/logo-${logo.sha256}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/svg+xml')
    expectImmutable(response)
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    )
    await response.body?.cancel()
    expect((await get(`${MAIN}/_/look/logo-${'0'.repeat(64)}`)).status).toBe(
      404,
    )
  })

  it('answers 404 for the same paths on a content host', async () => {
    const content = 'https://abcdefghij0123456789.content.test'
    for (const path of [
      `/_/look/${version}.css`,
      `/_/look/logo-${logo.sha256}`,
      `/_/fonts/${font.faces[0]!.sha256}.woff2`,
    ]) {
      const response = await get(`${content}${path}`)
      expect(response.status, path).toBe(404)
      expect(response.headers.get('content-type')).not.toContain('css')
      await response.body?.cancel()
    }
  })

  it('never puts the Look into a composed frame page', async () => {
    const owner: Browser = await signedIn(fresh())
    const caller = await callerOf(owner)
    const ws = await workspace(caller.person!)
    const result = (await pushAll(
      await agent(caller.person!),
      `${ws.name}/look`,
      {
        'plan.html': '<!doctype html><title>Plan</title><p>Plan</p>',
        'body.html': '<p>Only a body</p>',
      },
    )) as CommitResult | StageResult
    if (!('number' in result)) throw new Error('the push did not commit')
    const treeId: TreeId = result.treeId
    for (const path of ['plan', 'body']) {
      const view = await owner.fetch('/_/api/view', {
        method: 'POST',
        purpose: 'write',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tree: treeId, path }),
      })
      const { handle } = (await view.json()) as { handle: string }
      const page = await owner.fetch(`/_/v/${handle}/1/${path}`, {
        host: `${treeId}.content.test`,
        purpose: 'none',
      })
      expect(page.status).toBe(200)
      const html = await page.text()
      expect(html).not.toContain('/_/look/')
      expect(html).not.toContain('/_/fonts/')
      expect(html).not.toContain('Dossier Display')
    }
    // Nor the shell around it.
    const shell = await owner.fetch(`/${ws.name}/look/plan`)
    const text = await shell.text()
    expect(text).not.toContain('/_/look/')
    expect(text).not.toContain('/_/fonts/')
  })
})
