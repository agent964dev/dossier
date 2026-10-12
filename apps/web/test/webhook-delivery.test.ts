// Webhook deliveries end to end inside the test isolate: a commit's Queue
// message, the consumer's fan-out and deliveries to a receiver that stands
// in for each test's host, retries and "Failing since", the rechecks, and the
// five-minute sweep. Times move with TestClock.
import type { Person } from '@dossier/contracts'
import { createScheduledController } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { Webhook } from 'standardwebhooks'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  ChangeFeedRecorder,
  FAILING_AFTER,
  RETRY_DELAYS_SECONDS,
  type Caller,
  type CoreRuntime,
  type WebhookId,
  type WebhookMessage,
} from '../src/core/index.ts'
import { WEBHOOK_SWEEP } from '../src/jobs/scheduled.ts'
import { beforeRead, exec, failingStatements, rows } from './support/d1.ts'
import { harness, testRuntime } from './support/harness.ts'
import { sessionFor } from './support/people.ts'
import { at, DAY, HOUR, MINUTE, pushAt } from './support/purge.ts'
import { agent, person, workspace } from './support/trees.ts'
import {
  consumeAt,
  installReceiver,
  recordingQueue,
  sweepAt,
  webhookRuntime,
  webhooks,
} from './support/webhooks.ts'
import worker from './support/worker.ts'

const SECOND = 1000

const receiver = installReceiver()
afterAll(() => receiver.restore())
afterEach(() => harness.reset())

interface Space {
  readonly admin: Person
  readonly adminCaller: Caller
  readonly key: Caller
  readonly ws: { readonly id: string; readonly name: string }
}

const space = async (): Promise<Space> => {
  const admin = await person('hooks-admin')
  return {
    admin,
    adminCaller: await sessionFor(admin),
    key: await agent(admin),
    ws: await workspace(admin),
  }
}

const addAt = (
  time: number,
  s: Space,
  url: string,
  events: readonly string[] = ['push'],
) =>
  at(
    time,
    s.adminCaller,
    webhooks((w) =>
      w.create({ workspace: s.ws.name, url, events: events as never }),
    ),
  )

const listAt = (time: number, s: Space) =>
  at(
    time,
    s.adminCaller,
    webhooks((w) => w.list(s.ws.name)),
  )

const deliveries = (webhookId: string) =>
  rows<{
    event_tree_id: string
    event_seq: number
    state: string
    attempts: number
    next_at: number
    last_status: number | null
    last_error: string | null
  }>(
    'select * from webhook_deliveries where webhook_id = ? order by event_seq',
    webhookId,
  )

const deliverOf = (
  messages: readonly WebhookMessage[],
  webhookId: string,
): WebhookMessage[] =>
  messages.filter((m) => m.kind === 'deliver' && m.webhookId === webhookId)

/** A push of one page at `time`; the tree and the push event's seq. */
const pushPage = async (time: number, s: Space, tree = 'acme', n = 1) => {
  const result = await pushAt(
    time,
    s.key,
    `${s.ws.name}/${tree}`,
    { [`page-${n}.html`]: `<title>Page ${n}</title><p>${time}</p>` },
    { force: true },
  )
  if (!('treeId' in result)) throw new Error('the push changed nothing')
  const [event] = await rows<{ seq: number }>(
    "select seq from events where tree_id = ? and type = 'push' order by seq desc limit 1",
    result.treeId,
  )
  return { treeId: result.treeId as string, seq: event!.seq }
}

let runtime: CoreRuntime
let queue: ReturnType<typeof recordingQueue>

const fresh = () => {
  queue = recordingQueue()
  runtime = webhookRuntime(queue.queue)
}

describe('after a commit', () => {
  beforeAll(fresh)

  it('records one Queue message for the commit’s event range', async () => {
    harness.use(runtime)
    const s = await space()
    queue.take()
    const T = Date.now()
    const { treeId, seq } = await pushPage(T, s)
    expect(queue.take()).toEqual([
      { kind: 'events', treeId, fromSeq: seq, toSeq: seq },
    ])
  })

  it('records the same message in the test feed, beside the hub hint', async () => {
    const feed = ChangeFeedRecorder()
    harness.use(testRuntime({ overrides: { changeFeed: feed.layer } }))
    const s = await space()
    const { treeId, seq } = await pushPage(Date.now(), s)
    expect(feed.published().map((c) => c.treeId)).toEqual([treeId])
    expect(feed.queued()).toEqual([
      { kind: 'events', treeId, fromSeq: seq, toSeq: seq },
    ])
  })

  it('sends nothing for a commit when the Queue is down, and the change stands', async () => {
    harness.use(runtime)
    const s = await space()
    queue.setDown(true)
    try {
      const { seq } = await pushPage(Date.now(), s)
      expect(seq).toBeGreaterThan(0)
    } finally {
      queue.setDown(false)
    }
    expect(queue.take()).toEqual([])
  })
})

describe('the consumer', () => {
  beforeAll(fresh)

  it('writes a delivery for each webhook that takes the event and existed then, and delivers it signed', async () => {
    harness.use(runtime)
    const s = await space()
    const T = Date.now()
    const takes = receiver.host()
    const other = receiver.host()
    const later = receiver.host()
    const yes = await addAt(T, s, takes.url, ['push', 'comment'])
    const no = await addAt(T, s, other.url, ['submission'])
    queue.take()
    const { treeId, seq } = await pushPage(T + SECOND, s)
    const late = await addAt(T + 2 * SECOND, s, later.url, ['push'])
    const events = queue.take()
    expect(events).toHaveLength(1)

    const fanned = await consumeAt(runtime, T + 3 * SECOND, events)
    expect(fanned.explicitAcks).toEqual(fanned.ids)
    expect(await deliveries(yes.webhook.id)).toMatchObject([
      { event_tree_id: treeId, event_seq: seq, state: 'pending', attempts: 0 },
    ])
    expect(await deliveries(no.webhook.id)).toEqual([])
    expect(await deliveries(late.webhook.id)).toEqual([])
    const sent = queue.take()
    expect(sent).toEqual([
      { kind: 'deliver', treeId, seq, webhookId: yes.webhook.id },
    ])

    const when = Date.now()
    const delivered = await consumeAt(runtime, when, sent)
    expect(delivered.explicitAcks).toEqual(delivered.ids)
    expect(delivered.retryMessages).toEqual([])
    const [got] = takes.received()
    expect(takes.received()).toHaveLength(1)
    expect(other.received()).toEqual([])
    expect(later.received()).toEqual([])
    expect(got!.url).toBe(takes.url)
    expect(got!.headers).toMatchObject({
      'content-type': 'application/json',
      'user-agent': 'Dossier-Webhooks/1',
      'webhook-id': `evt_${treeId}_${seq}`,
      'webhook-timestamp': String(Math.floor(when / 1000)),
    })
    const payload = new Webhook(yes.secret).verify(got!.body, got!.headers)
    const [row] = await rows<{ created_at: number; number: number }>(
      `select e.created_at, p.number from events e join pushes p on p.id = e.push_id
       where e.tree_id = ? and e.seq = ?`,
      treeId,
      seq,
    )
    const iso = new Date(row!.created_at).toISOString()
    expect(payload).toEqual({
      type: 'push',
      timestamp: iso,
      data: {
        deployment: 'dossier.test',
        workspace: s.ws.name,
        tree: { id: treeId, name: 'acme' },
        event: {
          seq,
          type: 'push',
          path: '',
          at: iso,
          by: s.admin.email,
          push: row!.number,
        },
        link: `https://dossier.test/${s.ws.name}/acme/`,
      },
    })
    expect(await deliveries(yes.webhook.id)).toMatchObject([
      { state: 'delivered', attempts: 1, last_status: 200 },
    ])
    // The same message again sends nothing more.
    const again = await consumeAt(runtime, when + SECOND, sent)
    expect(again.explicitAcks).toEqual(again.ids)
    expect(takes.received()).toHaveLength(1)
    // And so does the events message again.
    await consumeAt(runtime, when + 2 * SECOND, events)
    expect(deliverOf(queue.take(), yes.webhook.id)).toEqual([])
  })

  it('retries a failing receiver with backoff, shows "Failing since" after the third failure in a row, and clears it on a success', async () => {
    harness.use(runtime)
    const s = await space()
    const T = Date.now()
    const host = receiver.host(500, 500, 500, 200)
    const hook = await addAt(T, s, host.url)
    queue.take()
    const { seq } = await pushPage(T + SECOND, s)
    await consumeAt(runtime, T + 2 * SECOND, queue.take())
    const [deliver] = queue.take()
    let now = T + 3 * SECOND
    for (let n = 1; n <= FAILING_AFTER; n += 1) {
      const result = await consumeAt(runtime, now, [deliver!])
      expect(result.explicitAcks).toEqual([])
      expect(result.retryMessages).toEqual([
        { msgId: result.ids[0], delaySeconds: RETRY_DELAYS_SECONDS[n - 1] },
      ])
      const [row] = await deliveries(hook.webhook.id)
      expect(row).toMatchObject({
        event_seq: seq,
        state: 'pending',
        attempts: n,
        last_status: 500,
        last_error: 'HTTP 500',
        next_at: now + RETRY_DELAYS_SECONDS[n - 1]! * SECOND,
      })
      const [view] = (await listAt(now, s)).webhooks
      expect(view!.failing).toEqual(
        n < FAILING_AFTER
          ? null
          : { since: T + 3 * SECOND, lastError: 'HTTP 500' },
      )
      now += RETRY_DELAYS_SECONDS[n - 1]! * SECOND
    }
    // Early, a message finds the delivery not yet due and comes back then.
    const early = await consumeAt(runtime, now - MINUTE, [deliver!])
    expect(early.explicitAcks).toEqual([])
    expect(early.retryMessages).toEqual([
      { msgId: early.ids[0], delaySeconds: 61 },
    ])
    expect(host.received()).toHaveLength(3)

    const done = await consumeAt(runtime, now, [deliver!])
    expect(done.explicitAcks).toEqual(done.ids)
    expect(host.received()).toHaveLength(4)
    const [view] = (await listAt(now, s)).webhooks
    expect(view).toMatchObject({ failing: null, lastSuccessAt: now })
    expect(await deliveries(hook.webhook.id)).toMatchObject([
      { state: 'delivered', attempts: 4 },
    ])
  })

  it('keeps sending new events to a failing webhook', async () => {
    harness.use(runtime)
    const s = await space()
    const T = Date.now()
    const host = receiver.host(502, 502, 502)
    const hook = await addAt(T, s, host.url)
    queue.take()
    await pushPage(T + SECOND, s, 'acme', 1)
    await consumeAt(runtime, T + 2 * SECOND, queue.take())
    const [first] = queue.take()
    let now = T + 3 * SECOND
    for (let n = 1; n <= FAILING_AFTER; n += 1) {
      await consumeAt(runtime, now, [first!])
      now += RETRY_DELAYS_SECONDS[n - 1]! * SECOND
    }
    const [failing] = (await listAt(now, s)).webhooks
    expect(failing!.failing).toMatchObject({ lastError: 'HTTP 502' })

    const second = await pushPage(now, s, 'acme', 2)
    await consumeAt(runtime, now + SECOND, queue.take())
    const sent = deliverOf(queue.take(), hook.webhook.id)
    expect(sent).toEqual([
      {
        kind: 'deliver',
        treeId: second.treeId,
        seq: second.seq,
        webhookId: hook.webhook.id,
      },
    ])
    await consumeAt(runtime, now + 2 * SECOND, sent)
    expect(host.received()).toHaveLength(FAILING_AFTER + 1)
    expect(JSON.parse(host.received().at(-1)!.body)).toMatchObject({
      data: { event: { seq: second.seq } },
    })
  })

  it('marks a delivery failed after its ninth failed attempt, and stops', async () => {
    harness.use(runtime)
    const s = await space()
    const T = Date.now()
    const host = receiver.host(...Array<number>(9).fill(500))
    const hook = await addAt(T, s, host.url)
    queue.take()
    await pushPage(T + SECOND, s)
    await consumeAt(runtime, T + 2 * SECOND, queue.take())
    const [deliver] = queue.take()
    let now = T + 3 * SECOND
    for (let n = 1; n <= 9; n += 1) {
      const result = await consumeAt(runtime, now, [deliver!])
      if (n < 9) {
        expect(result.retryMessages).toHaveLength(1)
        now += RETRY_DELAYS_SECONDS[n - 1]! * SECOND
      } else {
        expect(result.retryMessages).toEqual([])
        expect(result.explicitAcks).toEqual(result.ids)
      }
    }
    expect(await deliveries(hook.webhook.id)).toMatchObject([
      { state: 'failed', attempts: 9, last_error: 'HTTP 500' },
    ])
    // About 22 hours from the first attempt to the last.
    expect(now - (T + 3 * SECOND)).toBe(
      RETRY_DELAYS_SECONDS.reduce((a, b) => a + b, 0) * SECOND,
    )
    await consumeAt(runtime, now + HOUR, [deliver!])
    expect(host.received()).toHaveLength(9)
  })

  it('lets one of two copies of a message send, and brings the other back once the first is done', async () => {
    harness.use(runtime)
    const s = await space()
    const T = Date.now()
    const host = receiver.host()
    const hook = await addAt(T, s, host.url)
    queue.take()
    await pushPage(T + SECOND, s)
    await consumeAt(runtime, T + 2 * SECOND, queue.take())
    const sent = deliverOf(queue.take(), hook.webhook.id)
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    host.during(() => held)
    const first = consumeAt(runtime, T + 3 * SECOND, sent)
    // While the first copy's request is in flight, the second finds the
    // delivery held and comes back after the claim's lease.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const second = await consumeAt(runtime, T + 4 * SECOND, sent)
    expect(second.explicitAcks).toEqual([])
    expect(second.retryMessages).toEqual([
      { msgId: second.ids[0], delaySeconds: 60 },
    ])
    release()
    expect((await first).explicitAcks).toHaveLength(1)
    host.during(async () => {})
    const later = await consumeAt(runtime, T + 64 * SECOND, sent)
    expect(later.explicitAcks).toEqual(later.ids)
    expect(host.received()).toHaveLength(1)
    expect(await deliveries(hook.webhook.id)).toMatchObject([
      { state: 'delivered', attempts: 1 },
    ])
  })

  it('lets its claim go when D1 fails after claiming, so the retry delivers', async () => {
    const s = await space()
    const T = Date.now()
    const host = receiver.host()
    harness.use(runtime)
    const hook = await addAt(T, s, host.url)
    queue.take()
    await pushPage(T + SECOND, s)
    await consumeAt(runtime, T + 2 * SECOND, queue.take())
    const sent = deliverOf(queue.take(), hook.webhook.id)
    const broken = testRuntime({
      env: {
        WEBHOOKS: queue.queue,
        DB: failingStatements(env.DB, (q) =>
          q.trim().endsWith('from webhooks where id = ?'),
        ),
      },
    })
    const failed = await consumeAt(broken, T + 3 * SECOND, sent)
    expect(failed.retryMessages).toEqual([
      { msgId: failed.ids[0], delaySeconds: 30 },
    ])
    expect(host.received()).toEqual([])
    const retried = await consumeAt(runtime, T + 33 * SECOND, sent)
    expect(retried.explicitAcks).toEqual(retried.ids)
    expect(host.received()).toHaveLength(1)
  })

  it('never counts a request to a URL since edited away against the new one', async () => {
    harness.use(runtime)
    const s = await space()
    const T = Date.now()
    const old = receiver.host(500)
    const next = receiver.host()
    const hook = await addAt(T, s, old.url)
    queue.take()
    await pushPage(T + SECOND, s)
    await consumeAt(runtime, T + 2 * SECOND, queue.take())
    const sent = deliverOf(queue.take(), hook.webhook.id)
    // The admin edits the URL while the request to the old one is out.
    old.during(async () => {
      await exec(
        'update webhooks set url = ? where id = ?',
        next.url,
        hook.webhook.id,
      )
    })
    await consumeAt(runtime, T + 3 * SECOND, sent)
    const [row] = await rows<{ consecutive_failures: number; url: string }>(
      'select consecutive_failures, url from webhooks where id = ?',
      hook.webhook.id,
    )
    expect(row).toEqual({ consecutive_failures: 0, url: next.url })
    // The delivery itself waits for its retry, now to the new URL.
    expect(await deliveries(hook.webhook.id)).toMatchObject([
      { state: 'pending', attempts: 1, last_error: 'HTTP 500' },
    ])
    await consumeAt(runtime, T + 33 * SECOND, sent)
    expect(next.received()).toHaveLength(1)
  })

  it('never lets a stale attempt skip a delivery another attempt has claimed since', async () => {
    harness.use(runtime)
    const s = await space()
    const T = Date.now()
    const host = receiver.host()
    const hook = await addAt(T, s, host.url)
    queue.take()
    await pushPage(T + SECOND, s)
    await consumeAt(runtime, T + 2 * SECOND, queue.take())
    const sent = deliverOf(queue.take(), hook.webhook.id)
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    host.during(() => held)
    let second: ReturnType<typeof consumeAt> | undefined
    // Attempt A claims, then stalls before its recheck. Its lease runs out,
    // attempt B claims and sends, and only then does A read the workspace,
    // suspended meanwhile.
    const stalled = beforeRead(
      env.DB,
      (q) => q.includes('as nodeKind'),
      async () => {
        second = consumeAt(runtime, T + 64 * SECOND, sent)
        while (host.received().length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        await exec(
          'update workspaces set suspended_at = ? where id = ?',
          T,
          s.ws.id,
        )
      },
    )
    await consumeAt(
      testRuntime({ env: { WEBHOOKS: queue.queue, DB: stalled } }),
      T + 3 * SECOND,
      sent,
    )
    release()
    await second
    host.during(async () => {})
    expect(host.received()).toHaveLength(1)
    expect(await deliveries(hook.webhook.id)).toMatchObject([
      { state: 'delivered', attempts: 1, last_status: 200 },
    ])
  })

  it('records a delivery and its webhook’s health together, or neither', async () => {
    harness.use(runtime)
    const s = await space()
    const T = Date.now()
    const host = receiver.host(500, 500, 500)
    const hook = await addAt(T, s, host.url)
    queue.take()
    await pushPage(T + SECOND, s)
    await consumeAt(runtime, T + 2 * SECOND, queue.take())
    const sent = deliverOf(queue.take(), hook.webhook.id)
    let now = T + 3 * SECOND
    for (let n = 1; n <= FAILING_AFTER; n += 1) {
      await consumeAt(runtime, now, sent)
      now += RETRY_DELAYS_SECONDS[n - 1]! * SECOND
    }
    expect((await listAt(now, s)).webhooks[0]!.failing).not.toBeNull()
    // The receiver answers, but writing the webhook's health fails.
    const broken = testRuntime({
      env: {
        WEBHOOKS: queue.queue,
        DB: failingStatements(env.DB, (q) =>
          q.includes('update webhooks set failing_since = null'),
        ),
      },
    })
    const failed = await consumeAt(broken, now, sent)
    expect(failed.retryMessages).toHaveLength(1)
    expect(await deliveries(hook.webhook.id)).toMatchObject([
      { state: 'pending', attempts: FAILING_AFTER },
    ])
    const retried = await consumeAt(runtime, now + 31 * SECOND, sent)
    expect(retried.explicitAcks).toEqual(retried.ids)
    expect(await deliveries(hook.webhook.id)).toMatchObject([
      { state: 'delivered', attempts: FAILING_AFTER + 1 },
    ])
    expect((await listAt(now + 31 * SECOND, s)).webhooks[0]).toMatchObject({
      failing: null,
      lastSuccessAt: now + 31 * SECOND,
    })
  })

  it('names a timeout, a redirect it did not follow and a refused connection', async () => {
    harness.use(runtime)
    const s = await space()
    const T = Date.now()
    const cases = [
      ['timeout', 'timed out after 10 s'],
      [302, 'redirect not followed'],
      ['refuse', 'could not connect'],
    ] as const
    for (const [n, [answer, error]] of cases.entries()) {
      const host = receiver.host(answer)
      const hook = await addAt(T, s, host.url)
      queue.take()
      await pushPage(T + SECOND, s, `tree${n}`)
      await consumeAt(runtime, T + 2 * SECOND, queue.take())
      const sent = deliverOf(queue.take(), hook.webhook.id)
      await consumeAt(runtime, T + 3 * SECOND, sent)
      expect(await deliveries(hook.webhook.id)).toMatchObject([
        { state: 'pending', attempts: 1, last_error: error },
      ])
      expect(host.received()).toHaveLength(1)
      // Never followed: a redirect would take the delivery to a host the
      // admin did not name.
      expect(host.received()[0]!.redirect).toBe('manual')
      await at(
        T,
        s.adminCaller,
        webhooks((w) =>
          w.remove({ workspace: s.ws.name, id: hook.webhook.id as WebhookId }),
        ),
      )
    }
  })
})

describe('the rechecks before each attempt', () => {
  beforeAll(fresh)

  /** A webhook with a delivery waiting, and its message. */
  const waiting = async () => {
    const s = await space()
    const T = Date.now()
    const host = receiver.host()
    const hook = await addAt(T, s, host.url)
    queue.take()
    const event = await pushPage(T + SECOND, s)
    await consumeAt(runtime, T + 2 * SECOND, queue.take())
    const sent = deliverOf(queue.take(), hook.webhook.id)
    expect(sent).toHaveLength(1)
    return { s, T, host, hook, event, sent }
  }

  it('sends nothing for a webhook deleted meanwhile', async () => {
    harness.use(runtime)
    const { s, T, host, hook, sent } = await waiting()
    await at(
      T,
      s.adminCaller,
      webhooks((w) =>
        w.remove({ workspace: s.ws.name, id: hook.webhook.id as WebhookId }),
      ),
    )
    const result = await consumeAt(runtime, T + 3 * SECOND, sent)
    expect(result.explicitAcks).toEqual(result.ids)
    expect(host.received()).toEqual([])
    // Its deliveries went with it.
    expect(await deliveries(hook.webhook.id)).toEqual([])
  })

  it('skips a delivery of a suspended workspace', async () => {
    harness.use(runtime)
    const { s, T, host, hook, sent } = await waiting()
    await exec(
      'update workspaces set suspended_at = ? where id = ?',
      T,
      s.ws.id,
    )
    const result = await consumeAt(runtime, T + 3 * SECOND, sent)
    expect(result.explicitAcks).toEqual(result.ids)
    expect(host.received()).toEqual([])
    expect(await deliveries(hook.webhook.id)).toMatchObject([
      { state: 'skipped', attempts: 0 },
    ])
  })

  it('skips a delivery of a tree that moved to another workspace', async () => {
    harness.use(runtime)
    const { s, T, host, hook, event, sent } = await waiting()
    const elsewhere = await workspace(s.admin)
    await exec(
      'update trees set workspace_id = ? where id = ?',
      elsewhere.id,
      event.treeId,
    )
    const result = await consumeAt(runtime, T + 3 * SECOND, sent)
    expect(result.explicitAcks).toEqual(result.ids)
    expect(host.received()).toEqual([])
    expect(await deliveries(hook.webhook.id)).toMatchObject([
      { state: 'skipped' },
    ])
  })

  it('skips an event type the webhook no longer takes', async () => {
    harness.use(runtime)
    const { s, T, host, hook, sent } = await waiting()
    await at(
      T,
      s.adminCaller,
      webhooks((w) =>
        w.update({
          workspace: s.ws.name,
          id: hook.webhook.id as WebhookId,
          url: host.url,
          events: ['comment'],
        }),
      ),
    )
    await consumeAt(runtime, T + 3 * SECOND, sent)
    expect(host.received()).toEqual([])
    expect(await deliveries(hook.webhook.id)).toMatchObject([
      { state: 'skipped' },
    ])
  })
})

describe('the sweep', () => {
  beforeAll(fresh)

  it('runs on the five-minute schedule and sends a delivery whose Queue message was lost', async () => {
    harness.use(runtime)
    const s = await space()
    const T = Date.now() - 10 * MINUTE
    const host = receiver.host()
    const hook = await addAt(T, s, host.url)
    const event = await pushPage(T + SECOND, s)
    // The commit's message never reached the Queue.
    queue.take()
    await worker.scheduled(
      createScheduledController({
        scheduledTime: new Date(),
        cron: WEBHOOK_SWEEP,
      }),
    )
    expect(await deliveries(hook.webhook.id)).toMatchObject([
      { event_seq: event.seq, state: 'pending', attempts: 0 },
    ])
    const sent = deliverOf(queue.take(), hook.webhook.id)
    expect(sent).toEqual([
      {
        kind: 'deliver',
        treeId: event.treeId,
        seq: event.seq,
        webhookId: hook.webhook.id,
      },
    ])
    await consumeAt(runtime, Date.now(), sent)
    expect(host.received()).toHaveLength(1)
    // A second sweep finds nothing missing.
    await sweepAt(runtime, Date.now())
    expect(deliverOf(queue.take(), hook.webhook.id)).toEqual([])
  })

  it('sends again a pending delivery whose retry was lost, and leaves one that is not due', async () => {
    harness.use(runtime)
    const s = await space()
    const T = Date.now()
    const host = receiver.host(500)
    const hook = await addAt(T, s, host.url)
    queue.take()
    await pushPage(T + SECOND, s)
    await consumeAt(runtime, T + 2 * SECOND, queue.take())
    const first = queue.take()
    await consumeAt(runtime, T + 3 * SECOND, first)
    // The retry is due in 30 s: the sweep leaves it.
    await sweepAt(runtime, T + 4 * SECOND)
    expect(deliverOf(queue.take(), hook.webhook.id)).toEqual([])
    // Its message is lost; ten minutes after it was due, the sweep sends it.
    await sweepAt(runtime, T + 3 * SECOND + 30 * SECOND + 11 * MINUTE)
    const again = deliverOf(queue.take(), hook.webhook.id)
    expect(again).toEqual(deliverOf(first, hook.webhook.id))
    await consumeAt(runtime, T + 12 * MINUTE + 40 * SECOND, again)
    expect(host.received()).toHaveLength(2)
    expect(await deliveries(hook.webhook.id)).toMatchObject([
      { state: 'delivered', attempts: 2 },
    ])
  })

  it('leaves events older than a day alone', async () => {
    harness.use(runtime)
    const s = await space()
    const now = Date.now()
    const hook = await addAt(now - 26 * HOUR, s, receiver.host().url)
    await pushPage(now - 25 * HOUR, s)
    queue.take()
    await sweepAt(runtime, now)
    expect(await deliveries(hook.webhook.id)).toEqual([])
    expect(deliverOf(queue.take(), hook.webhook.id)).toEqual([])
  })

  it('deletes delivery rows older than the retention period', async () => {
    harness.use(runtime)
    const s = await space()
    const now = Date.now()
    const hook = await addAt(now - 40 * DAY, s, receiver.host().url)
    const keep = now - 29 * DAY
    for (const [seq, created] of [
      [1, now - 31 * DAY],
      [2, keep],
    ] as const) {
      await exec(
        `insert into webhook_deliveries (event_tree_id, event_seq, webhook_id, state,
           attempts, next_at, created_at, delivered_at)
         values ('oldtree', ?, ?, 'delivered', 1, ?, ?, ?)`,
        seq,
        hook.webhook.id,
        created,
        created,
        created,
      )
    }
    await sweepAt(runtime, now)
    expect((await deliveries(hook.webhook.id)).map((r) => r.event_seq)).toEqual(
      [2],
    )
  })

  it('logs and leaves rows pending while the Queue is unreachable, and sends them on the next run', async () => {
    harness.use(runtime)
    const s = await space()
    const T = Date.now() - 5 * MINUTE
    const hook = await addAt(T, s, receiver.host().url)
    queue.setDown(true)
    try {
      await pushPage(T + SECOND, s)
      await sweepAt(runtime, Date.now())
    } finally {
      queue.setDown(false)
    }
    expect(await deliveries(hook.webhook.id)).toMatchObject([
      { state: 'pending' },
    ])
    expect(deliverOf(queue.take(), hook.webhook.id)).toEqual([])
    // The row is written but its message is not: once late, the next run
    // sends it.
    await sweepAt(runtime, Date.now() + 11 * MINUTE)
    expect(deliverOf(queue.take(), hook.webhook.id)).toHaveLength(1)
  })
})

describe('the Worker’s queue handler', () => {
  beforeAll(fresh)

  it('hands the Queue’s batch to the consumer as the delivery job', async () => {
    harness.use(runtime)
    const s = await space()
    const host = receiver.host()
    const T = Date.now() - MINUTE
    const hook = await addAt(T, s, host.url)
    queue.take()
    await pushPage(T + SECOND, s)
    const { createMessageBatch, createExecutionContext, getQueueResult } =
      await import('cloudflare:test')
    const run = async (bodies: readonly WebhookMessage[]) => {
      const batch = createMessageBatch<WebhookMessage>(
        'dossier-next-dev',
        bodies.map((body, i) => ({
          id: `m${i}`,
          timestamp: new Date(),
          attempts: 1,
          body,
        })),
      )
      const ctx = createExecutionContext()
      await worker.queue(batch)
      return getQueueResult(batch, ctx)
    }
    expect((await run(queue.take())).explicitAcks).toEqual(['m0'])
    expect(
      (await run(deliverOf(queue.take(), hook.webhook.id))).explicitAcks,
    ).toEqual(['m0'])
    expect(host.received()).toHaveLength(1)
  })
})
