// Pushes and purges at a chosen time, through the real Push and Purge, and
// reads of what a purge leaves in D1 and R2.
import type { PushId, Sha256 } from '@dossier/contracts'
import { env } from 'cloudflare:workers'
import { Effect, TestClock, TestContext } from 'effect'

import {
  Purge,
  Push,
  type Background,
  type Caller,
  type CommitResult,
  type CoreRuntime,
  type CoreServices,
  type CurrentCaller,
  type PurgeOutcome,
} from '../../src/core/index.ts'
import { PurgeBudget } from '../../src/core/purge.ts'
import { SystemJob } from '../../src/core/system-store.ts'
import { rows } from './d1.ts'
import { harness } from './harness.ts'
import { runAs } from './people.ts'
import { ref, sha256Of, type Files, type PushOptions } from './trees.ts'

export const MINUTE = 60 * 1000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

const encoder = new TextEncoder()

/** Runs `effect` as `caller` with the clock at `time`. */
export const at = <A, E>(
  time: number,
  caller: Caller,
  effect: Effect.Effect<A, E, CoreServices | CurrentCaller | Background>,
): Promise<A> =>
  runAs(
    caller,
    Effect.gen(function* () {
      yield* TestClock.setTime(time)
      return yield* effect
    }).pipe(Effect.provide(TestContext.TestContext)),
  )

/** The same, answering the failure. */
export const failureAt = <A, E>(
  time: number,
  caller: Caller,
  effect: Effect.Effect<A, E, CoreServices | CurrentCaller | Background>,
): Promise<E> => at(time, caller, Effect.flip(effect))

const manifestOf = (files: Files) =>
  Promise.all(
    Object.entries(files).map(async ([path, text]) => ({
      path,
      sha256: await sha256Of(text),
      size: encoder.encode(text).length,
    })),
  )

/** Stages a push at `time`; the push's ID and the hashes it is missing. */
export const stageAt = async (
  time: number,
  caller: Caller,
  target: string,
  files: Files,
  options: PushOptions = {},
) => {
  const manifest = await manifestOf(files)
  return at(
    time,
    caller,
    Effect.flatMap(Push, (push) =>
      push.stage({
        target: ref(target),
        baseSeq: (options.baseSeq ?? null) as never,
        baseTree: (options.baseTree ?? null) as never,
        force: options.force ?? false,
        dryRun: false,
        message: options.message ?? null,
        files: manifest,
        share: [],
      }),
    ),
  )
}

/** The upload of one file's bytes into a staged push, as the CLI sends it. */
export const putBlobOf = async (pushId: PushId, text: string) => {
  const bytes = encoder.encode(text)
  const sha256 = await sha256Of(text)
  return Effect.flatMap(Push, (push) =>
    push.putBlob({
      pushId,
      sha256,
      size: bytes.length,
      body: new Blob([bytes]).stream() as ReadableStream<Uint8Array>,
    }),
  )
}

/** Uploads every file a staged push is missing, at `time`. */
export const uploadAt = async (
  time: number,
  caller: Caller,
  pushId: PushId,
  files: Files,
  missing: readonly Sha256[],
) => {
  const done = new Set<string>()
  for (const text of Object.values(files)) {
    const sha256 = await sha256Of(text)
    if (!missing.includes(sha256) || done.has(sha256)) continue
    done.add(sha256)
    await at(time, caller, await putBlobOf(pushId, text))
  }
}

/** A whole push at `time`: stage, upload what is missing, commit. */
export const pushAt = async (
  time: number,
  caller: Caller,
  target: string,
  files: Files,
  options: PushOptions = {},
): Promise<CommitResult> => {
  const staged = await stageAt(time, caller, target, files, options)
  if (staged.pushId === null) throw new Error('the push changed nothing')
  await uploadAt(time, caller, staged.pushId, files, staged.missing)
  return at(
    time,
    caller,
    Effect.flatMap(Push, (push) => push.commit(staged.pushId!)),
  )
}

/** The weekly purge as the scheduled job runs it, at `time`. */
const weekly = (
  time: number,
  budget?: { readonly statements: number; readonly millis: number },
) => {
  const runId = crypto.randomUUID()
  const work = Effect.gen(function* () {
    yield* TestClock.setTime(time)
    return yield* Effect.flatMap(Purge, (purge) => purge.run('weekly'))
  }).pipe(
    Effect.provideService(SystemJob, { job: 'purge', runId }),
    Effect.provide(TestContext.TestContext),
  )
  return budget === undefined
    ? work
    : work.pipe(Effect.provideService(PurgeBudget, budget))
}

export interface PurgeOptions {
  /** A runtime over other bindings, to land something during the run. */
  readonly runtime?: CoreRuntime
  readonly budget?: { readonly statements: number; readonly millis: number }
}

export const purgeAt = (
  time: number,
  options: PurgeOptions = {},
): Promise<PurgeOutcome> =>
  (options.runtime ?? harness.runtime()).runPromise(
    weekly(time, options.budget),
  )

export const purgeFailureAt = (time: number, options: PurgeOptions = {}) =>
  (options.runtime ?? harness.runtime()).runPromise(
    Effect.flip(weekly(time, options.budget)),
  )

export const blobRow = async (sha256: string) =>
  (
    await rows<{ ref_count: number; state: string }>(
      'select ref_count, state from blobs where sha256 = ?',
      sha256,
    )
  )[0] ?? null

/** Whether R2 holds an object at the key. */
export const stored = async (key: string) =>
  (await env.BLOBS.head(key)) !== null

/** The newest purge run's row. */
export const lastRunRow = async () =>
  (
    await rows<{
      id: string
      trigger: string
      state: string
      started_by: string | null
      error: string | null
      checkpoint_json: string
      counts_json: string
      lease_until: number
    }>('select * from purge_runs order by rowid desc limit 1')
  )[0]

/** A node by path, deleted or not: the newest one. */
export const anyNodeAt = async (treeId: string, path: string) =>
  (
    await rows<{ id: string; deleted_at: number | null }>(
      `select id, deleted_at from nodes where tree_id = ? and path = ?
       order by created_at desc limit 1`,
      treeId,
      path,
    )
  )[0]

/**
 * R2 bound so that each delete naming one of the keys runs `before` first:
 * a way to act while the purge holds a claim.
 */
export const beforeDelete = (
  bucket: R2Bucket,
  matches: (keys: readonly string[]) => boolean,
  before: () => Promise<void>,
): R2Bucket =>
  new Proxy(bucket, {
    get(target, property) {
      if (property === 'delete') {
        return async (keys: string | string[]) => {
          const list = typeof keys === 'string' ? [keys] : keys
          if (matches(list)) await before()
          return target.delete(keys)
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
