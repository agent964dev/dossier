// A page as deep as a push may place one, with a layout, a theme and a
// component in every folder above it: every way of opening it stays within
// D1's limits (100 bound values, 100 KB statements, expression depth 100).
import { MAX_DEPTH, type AuthoredSeq, type TreeId } from '@dossier/contracts'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { CurrentCaller, Pages, type Caller } from '../src/core/index.ts'
import { kitRuntime } from './support/base.ts'
import { signedIn } from './support/browser.ts'
import { recordingStatements } from './support/d1.ts'
import { harness } from './support/harness.ts'
import { callerOf, fresh, runAs } from './support/people.ts'
import {
  agent,
  nodeAt,
  pushAll,
  ref,
  share,
  workspace,
} from './support/trees.ts'

afterEach(() => harness.reset())

/** 31 folders with long names, and the page below them. */
const FOLDERS = Array.from(
  { length: MAX_DEPTH - 1 },
  (_, n) => `${String(n).padStart(2, '0')}${'f'.repeat(198)}`,
)
const folderAt = (depth: number) => FOLDERS.slice(0, depth).join('/')
const DEEP = folderAt(FOLDERS.length)
const PAGE = `${DEEP}/plan.html`

/**
 * Every folder from the root down holds a layout, a theme and an image, and
 * a component wherever one may sit (a node is at most 32 names deep).
 */
const files = (): Record<string, string> => {
  const out: Record<string, string> = {}
  for (let depth = 0; depth <= FOLDERS.length; depth += 1) {
    const at = folderAt(depth)
    const inside = (name: string) => (at === '' ? name : `${at}/${name}`)
    out[inside('_layout.html')] =
      `<link rel="stylesheet" href="_theme.css"><div class="l${depth}"><slot></slot></div>`
    out[inside('_theme.css')] = `.l${depth} { color: teal }`
    if (depth + 2 <= MAX_DEPTH) {
      out[inside(`_components/acme-c${depth}.js`)] = `export const c = ${depth}`
    }
    out[inside('logo.png')] = `logo ${depth}`
  }
  out[PAGE] = `<title>Plan</title>
<p>Deep</p>
${Array.from({ length: FOLDERS.length }, (_, n) => `<acme-c${n}></acme-c${n}>`).join('\n')}
${Array.from({ length: FOLDERS.length + 1 }, (_, n) => `<img src="${'../'.repeat(FOLDERS.length - n)}logo.png">`).join('\n')}
<form action="answers/" method="post"><input name="a"><button>Send</button></form>`
  return out
}

const bytes = (text: string) => new TextEncoder().encode(text).byteLength

describe('a page as deep as a push may place one', () => {
  it('opens through link, agent read, read, view, frame and export within D1’s limits', async () => {
    const kit = kitRuntime()
    harness.use(kit.runtime)
    const ownerBrowser = await signedIn(fresh())
    const owner = await callerOf(ownerBrowser)
    const ws = await workspace(owner.person!)
    const pushed = await pushAll(
      await agent(owner.person!),
      `${ws.name}/deep`,
      files(),
    )
    if (!('number' in pushed)) throw new Error(JSON.stringify(pushed))
    const treeId = pushed.treeId as TreeId
    // A reader holding only the page, and a key scoped to its folder.
    const reader = await callerOf(await signedIn(fresh()))
    await share(
      treeId,
      (await nodeAt(treeId, PAGE))!.id,
      'email',
      reader.person!.email,
      'read',
      owner.person!,
    )
    const scoped = await agent(owner.person!, {
      scope: (await nodeAt(treeId, DEEP))!.id as never,
    })

    const recorded = recordingStatements(env.DB)
    const runtime = kitRuntime({ env: { DB: recorded.db } })
    harness.use(runtime.runtime)
    const link = `${ws.name}/deep/${DEEP}/plan`
    const grants: { who: string; grant: { handle: string; seq: number } }[] = []
    const failures: string[] = []
    const attempt = async (name: string, run: () => Promise<unknown>) => {
      try {
        const result = await run()
        if (typeof result === 'string') failures.push(`${name}: ${result}`)
      } catch (error) {
        const text = String(error)
        failures.push(
          `${name}: ${/D1_ERROR[^\n]*/.exec(text)?.[0] ?? text.split('\n')[0]}`,
        )
      }
    }
    const asCaller = <A>(
      caller: Caller,
      effect: Effect.Effect<A, { readonly code: string }, never>,
    ) =>
      runAs(
        caller,
        effect.pipe(
          Effect.map(() => null),
          Effect.catchAll((error) => Effect.succeed(error.code)),
        ) as never,
      )
    for (const [who, caller] of [
      ['owner', owner],
      ['reader', reader],
      ['scoped key', scoped],
    ] as const) {
      await attempt(`${who} link`, () =>
        asCaller(
          caller,
          Effect.flatMap(Pages, (p) =>
            p.open({ ref: ref(link), wantsAgent: false }),
          ) as never,
        ),
      )
      await attempt(`${who} agent read of the link`, () =>
        asCaller(
          caller,
          Effect.flatMap(Pages, (p) =>
            p.open({ ref: ref(link), wantsAgent: true }),
          ) as never,
        ),
      )
      await attempt(`${who} read`, () =>
        asCaller(
          caller,
          Effect.flatMap(Pages, (p) => p.read(ref(link))) as never,
        ),
      )
      await attempt(`${who} export`, () =>
        asCaller(
          caller,
          Effect.flatMap(Pages, (p) => p.export({ ref: ref(link) })) as never,
        ),
      )
      if (caller.via.kind !== 'browser') continue
      let grant: { handle: string; seq: number } | null = null
      await attempt(`${who} view`, async () => {
        grant = await runAs(
          caller,
          Effect.flatMap(Pages, (p) =>
            p.view({ treeId, path: `${DEEP}/plan` }),
          ),
        )
      })
      if (grant === null) continue
      grants.push({ who, grant })
      const { handle, seq } = grant
      for (const wantsAgent of [false, true]) {
        await attempt(`${who} frame${wantsAgent ? ' (agent)' : ''}`, () =>
          runtime.runtime.runPromise(
            Effect.gen(function* () {
              const pages = yield* Pages
              const handleOf = yield* pages.handleCaller(handle, treeId)
              if (handleOf === null) return 'refused'
              const served = yield* pages
                .frame({
                  treeId,
                  seq: seq as AuthoredSeq,
                  path: `${DEEP}/plan`,
                  folder: false,
                  range: null,
                  ifNoneMatch: null,
                  host: `${treeId}.content.test`,
                  wantsAgent,
                })
                .pipe(Effect.provideService(CurrentCaller, handleOf))
              return served.kind === 'framePage' || served.kind === 'agent'
                ? null
                : `served ${served.kind}`
            }).pipe(Effect.catchAll((error) => Effect.succeed(error.code))),
          ),
        )
        // A layout file and a component the frame loads, at the sequence.
        for (const path of [
          `${DEEP}/_layout.html`,
          `${DEEP}/logo.png`,
          `${DEEP}/_theme.css`,
        ]) {
          await attempt(`${who} frame ${path.slice(DEEP.length)}`, () =>
            runtime.runtime.runPromise(
              Effect.gen(function* () {
                const pages = yield* Pages
                const handleOf = yield* pages.handleCaller(handle, treeId)
                if (handleOf === null) return 'refused'
                const served = yield* pages
                  .frame({
                    treeId,
                    seq: seq as AuthoredSeq,
                    path,
                    folder: false,
                    range: null,
                    ifNoneMatch: null,
                    host: `${treeId}.content.test`,
                    wantsAgent,
                  })
                  .pipe(Effect.provideService(CurrentCaller, handleOf))
                return served.kind === 'file' ? null : `served ${served.kind}`
              }).pipe(Effect.catchAll((error) => Effect.succeed(error.code))),
            ),
          )
        }
      }
    }
    // Every layout changes; the open tabs still frame the page as it was.
    const changed = Object.fromEntries(
      Object.entries(files()).map(([path, text]) => [
        path,
        path.endsWith('_layout.html') ? `${text}<!-- 2 -->` : text,
      ]),
    )
    const again = await pushAll(
      await agent(owner.person!),
      `${ws.name}/deep`,
      changed,
      { force: true },
    )
    if (!('number' in again)) throw new Error(JSON.stringify(again))
    expect(again.seq).toBeGreaterThan(grants[0]!.grant.seq)
    for (const { who, grant } of grants) {
      await attempt(`${who} frame at the earlier sequence`, () =>
        runtime.runtime.runPromise(
          Effect.gen(function* () {
            const pages = yield* Pages
            const handleOf = yield* pages.handleCaller(grant.handle, treeId)
            if (handleOf === null) return 'refused'
            const served = yield* pages
              .frame({
                treeId,
                seq: grant.seq as AuthoredSeq,
                path: `${DEEP}/plan`,
                folder: false,
                range: null,
                ifNoneMatch: null,
                host: `${treeId}.content.test`,
                wantsAgent: false,
              })
              .pipe(Effect.provideService(CurrentCaller, handleOf))
            if (served.kind !== 'framePage') return `served ${served.kind}`
            // Composed from all 32 layouts as they were.
            return (served.html.match(/class="l\d+"/g) ?? []).length === 32 &&
              !served.html.includes('<!-- 2 -->')
              ? null
              : 'not the page as it was'
          }).pipe(Effect.catchAll((error) => Effect.succeed(error.code))),
        ),
      )
    }
    const over = recorded
      .seen()
      .filter((s) => s.binds.length > 100 || bytes(s.sql) > 100_000)
      .map((s) => `${s.binds.length} binds, ${bytes(s.sql)} bytes`)
    expect({ failures, over }).toEqual({ failures: [], over: [] })
  }, 180_000)
})
