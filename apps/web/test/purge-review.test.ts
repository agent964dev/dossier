import { env } from 'cloudflare:workers'
import { Clock, Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { Files, Purge, TreeStore } from '../src/core/index.ts'
import { PurgeBudget } from '../src/core/purge.ts'
import { SystemJob } from '../src/core/system-store.ts'
import { exec } from './support/d1.ts'
import { harness, testRuntime } from './support/harness.ts'
import {
  at,
  beforeDelete,
  blobRow,
  DAY,
  HOUR,
  lastRunRow,
  MINUTE,
  purgeAt,
  pushAt,
  namesBlob,
  putBlob,
  stageAt,
  stored,
  storedBlob,
} from './support/purge.ts'
import { agent, person, ref, sha256Of, workspace } from './support/trees.ts'

const T = Date.UTC(2026, 9, 8, 9)

/** A clock that stands still until the test moves it. */
const manualClock = (start: number) => {
  let now = start
  const real = Clock.make()
  const clock: Clock.Clock = {
    [Clock.ClockTypeId]: Clock.ClockTypeId,
    unsafeCurrentTimeMillis: () => now,
    unsafeCurrentTimeNanos: () => BigInt(now) * 1_000_000n,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    sleep: (duration) => real.sleep(duration),
  }
  return {
    clock,
    advance: (ms: number) => {
      now += ms
    },
  }
}
afterEach(() => harness.reset())

describe('independent Phase 11 purge probes', () => {
  it('checks elapsed budget between blobs rather than after a whole fifty-blob batch', async () => {
    const keys = new Set<string>()
    for (let n = 0; n < 50; n += 1) {
      const text = `budget-orphan ${crypto.randomUUID()}`
      const sha = await sha256Of(text)
      keys.add(`blobs/${sha}`)
      await exec(
        `insert into blobs (sha256, size, ref_count, state, first_seen_at) values (?, ?, 0, 'live', ?)`,
        sha,
        text.length,
        T,
      )
      await putBlob(sha, text)
    }
    // The purge's clock moves only when a blob's bytes are deleted: each
    // delete takes 4 ms of a 100 ms budget, whatever the machine is doing.
    const clock = manualClock(Date.now())
    let deletes = 0
    const BLOBS = beforeDelete(
      env.BLOBS,
      (list) => list.some((key) => keys.has(key)),
      async () => {
        deletes += 1
        clock.advance(4)
      },
    )
    const runtime = testRuntime({ env: { BLOBS } })
    const weekly = (budget: { statements: number; millis: number }) =>
      runtime.runPromise(
        Effect.flatMap(Purge, (p) => p.run('weekly')).pipe(
          Effect.provideService(SystemJob, {
            job: 'purge',
            runId: crypto.randomUUID(),
          }),
          Effect.provideService(PurgeBudget, budget),
          Effect.withClock(clock.clock),
        ),
      )
    const result = await weekly({ statements: 800, millis: 100 })
    // It stopped between blobs once 100 ms had passed, not after the batch
    // of fifty it had claimed.
    expect(deletes).toBe(25)
    expect(result).toMatchObject({ remaining: true, blobs: 25 })
    // The claims it had no time for wait in its checkpoint, and the next run
    // removes them.
    const row = (await lastRunRow())!
    expect(row.state).toBe('partial')
    const left = JSON.parse(row.checkpoint_json) as {
      step: string
      claimed: string[]
    }
    expect(left.step).toBe('blobs')
    expect(left.claimed).toHaveLength(25)
    clock.advance(MINUTE)
    const rest = await weekly({ statements: 800, millis: 25_000 })
    expect(rest).toMatchObject({ remaining: false, blobs: 25 })
    for (const key of keys) expect(await stored(key)).toBe(false)
  })
  it('cleans an abandoned unverified upload hold after the decided one-day bound', async () => {
    const owner = await person('abandoned-upload-owner')
    const writer = await agent(owner)
    const text = `abandoned ${crypto.randomUUID()}`
    const sha = await sha256Of(text)
    const holder = { kind: 'upload' as const, id: crypto.randomUUID() }
    await at(
      T,
      writer,
      Effect.flatMap(TreeStore, (s) => s.holdBlob(holder, sha, text.length)),
    )
    await putBlob(sha, text)
    await purgeAt(T + 2 * DAY)
    expect(await blobRow(sha)).toBeNull()
  })
  it('cannot let a delayed old delete remove a live re-upload after lease takeover', async () => {
    const owner = await person('purge-race-owner')
    const ws = await workspace(owner)
    const writer = await agent(owner)
    const target = `${ws.name}/race${crypto.randomUUID().slice(0, 8)}`
    const text = `unique reacquired ${crypto.randomUUID()}\n`
    const sha = await sha256Of(text)
    await pushAt(T, writer, target, { 'gone.txt': text })
    await at(
      T + HOUR,
      writer,
      Effect.flatMap(Files, (f) => f.rm({ ref: ref(`${target}/gone.txt`) })),
    )
    const later = T + HOUR + 31 * DAY
    let takenOver = false
    const BLOBS = beforeDelete(
      env.BLOBS,
      (keys) => !takenOver && namesBlob(keys, sha),
      async () => {
        takenOver = true
        await purgeAt(later + 11 * MINUTE)
        await pushAt(
          later + 12 * MINUTE,
          writer,
          target,
          { 'gone.txt': text },
          { force: true },
        )
        expect(await storedBlob(sha)).toBe(true)
        expect(await blobRow(sha)).toMatchObject({
          state: 'live',
          ref_count: 1,
        })
      },
    )
    await purgeAt(later, {
      runtime: testRuntime({ env: { BLOBS } }),
    }).catch((error) => ({ error: String(error) }))
    expect(takenOver).toBe(true)
    expect(await storedBlob(sha)).toBe(true)
  })

  it('gives a current retry an upload hold despite an older verified hold', async () => {
    const owner = await person('retry-owner')
    const ws = await workspace(owner)
    const writer = await agent(owner)
    const target = `${ws.name}/retry${crypto.randomUUID().slice(0, 8)}`
    const text = `retry ${crypto.randomUUID()}`
    const sha = await sha256Of(text)
    const staged = await stageAt(T, writer, target, { 'retry.txt': text })
    const holder = { kind: 'push' as const, id: staged.pushId! }
    await at(
      T,
      writer,
      Effect.flatMap(TreeStore, (s) => s.holdBlob(holder, sha, text.length)),
    )
    await putBlob(sha, text)
    await at(
      T,
      writer,
      Effect.flatMap(TreeStore, (s) => s.confirmHold(holder, sha, text.length)),
    )
    await at(
      T + DAY - MINUTE,
      writer,
      Effect.flatMap(TreeStore, (s) => s.holdBlob(holder, sha, text.length)),
    )
    await purgeAt(T + DAY + MINUTE)
    expect(await storedBlob(sha)).toBe(true)
  })
})
