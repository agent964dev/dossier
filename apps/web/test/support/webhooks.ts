// Webhook tests: a Queue that records what is sent to it, a receiver that
// stands in for each test's own host inside the test isolate, and the
// consumer and sweep run as the system jobs the Worker runs.
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  type QueueResult,
} from 'cloudflare:test'
import { Effect, TestClock, TestContext } from 'effect'

import {
  CurrentCaller,
  Webhooks,
  type CoreRuntime,
  type WebhookMessage,
  type WebhooksService,
} from '../../src/core/index.ts'
import { SystemJob } from '../../src/core/system-store.ts'
import { harness, testRuntime } from './harness.ts'

/** A Queue binding that keeps every message sent to it. */
export const recordingQueue = () => {
  const sent: WebhookMessage[] = []
  /** The delay each message was sent with, beside it. */
  const delays: (number | undefined)[] = []
  let down = false
  const queue = {
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
    send: async (body: WebhookMessage, options?: QueueSendOptions) => {
      if (down) throw new Error('Queue unavailable')
      sent.push(body)
      delays.push(options?.delaySeconds)
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }
    },
    sendBatch: async (
      messages: Iterable<MessageSendRequest<WebhookMessage>>,
    ) => {
      if (down) throw new Error('Queue unavailable')
      for (const m of messages) {
        sent.push(m.body)
        delays.push(m.delaySeconds)
      }
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }
    },
  } as unknown as Queue<WebhookMessage>
  return {
    queue,
    /** Everything sent so far, oldest first. */
    sent: () => [...sent],
    /** Takes what was sent, leaving the Queue empty. */
    take: () => {
      delays.splice(0, delays.length)
      return sent.splice(0, sent.length)
    },
    /** Takes what was sent with each message's delay. */
    takeWithDelays: () => {
      const taken = delays.splice(0, delays.length)
      return sent
        .splice(0, sent.length)
        .map((body, i) => ({ body, delaySeconds: taken[i] }))
    },
    setDown: (value: boolean) => {
      down = value
    },
  }
}

export interface Received {
  readonly url: string
  /** How the sender asked fetch to treat a redirect. */
  readonly redirect: RequestRedirect
  readonly headers: Record<string, string>
  readonly body: string
}

type Answer = number | 'timeout' | 'refuse'

/**
 * Stands in for every host a test gives it: records each request and answers
 * with the status the host's script says next (200 once it runs out).
 */
export const installReceiver = () => {
  const realFetch = globalThis.fetch
  const hosts = new Map<
    string,
    {
      log: Received[]
      script: Answer[]
      onRequest?: () => Promise<void>
    }
  >()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const host = hosts.get(url.host)
    if (host === undefined) return realFetch(input, init)
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => {
      headers[key] = value
    })
    host.log.push({
      url: request.url,
      redirect: init?.redirect ?? request.redirect,
      headers,
      body: await request.text(),
    })
    await host.onRequest?.()
    const next = host.script.shift() ?? 200
    if (next === 'timeout') {
      // Hangs until the sender's own signal gives up on it.
      const signal = init?.signal ?? request.signal
      return await new Promise<never>((_, reject) => {
        if (signal === null || signal === undefined) return
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        })
      })
    }
    if (next === 'refuse') throw new TypeError('Network connection lost.')
    return new Response(next >= 300 && next < 400 ? null : 'ok', {
      status: next,
      headers:
        next >= 300 && next < 400
          ? { location: 'https://elsewhere.example.org/' }
          : {},
    })
  }) as typeof fetch
  let serial = 0
  return {
    /** A new receiver host; the answers it gives, in order. */
    host: (...script: Answer[]) => {
      serial += 1
      const name = `hooks-${Date.now().toString(36)}${serial}.example.com`
      const entry: {
        log: Received[]
        script: Answer[]
        onRequest?: () => Promise<void>
      } = { log: [], script }
      hosts.set(name, entry)
      return {
        url: `https://${name}/dossier`,
        received: () => [...entry.log],
        answer: (...more: Answer[]) => {
          entry.script.push(...more)
        },
        /** Runs while each request is in flight, before it is answered. */
        during: (run: () => Promise<void>) => {
          entry.onRequest = run
        },
      }
    },
    restore: () => {
      globalThis.fetch = realFetch
    },
  }
}

/** A runtime over the recording Queue, served by the test Worker meanwhile. */
export const webhookRuntime = (queue: Queue<WebhookMessage>): CoreRuntime => {
  const runtime = testRuntime({ env: { WEBHOOKS: queue } })
  harness.use(runtime)
  return runtime
}

/** Runs `effect` as the deployment's job, with the clock at `time`. */
const asSystemAt = <A, E>(
  runtime: CoreRuntime,
  time: number,
  job: 'deliver' | 'sweep',
  effect: Effect.Effect<A, E, Webhooks | CurrentCaller | SystemJob>,
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(time)
      return yield* effect
    }).pipe(
      Effect.provideService(SystemJob, { job, runId: crypto.randomUUID() }),
      Effect.provideService(CurrentCaller, {
        person: null,
        via: { kind: 'system', job },
        requestId: 'test',
      }),
      Effect.provide(TestContext.TestContext),
    ),
  )

/** The consumer over these messages at `time`, and what it acked or retried. */
export const consumeAt = async (
  runtime: CoreRuntime,
  time: number,
  bodies: readonly WebhookMessage[],
): Promise<QueueResult & { readonly ids: readonly string[] }> => {
  const ids = bodies.map(() => crypto.randomUUID())
  const batch = createMessageBatch<WebhookMessage>(
    'dossier-next-dev',
    bodies.map((body, i) => ({
      id: ids[i]!,
      timestamp: time,
      attempts: 1,
      body,
    })),
  )
  const ctx = createExecutionContext()
  // getQueueResult (vitest plugin 1.1.8) records that a message was retried
  // but drops the delay it was given; each message here passes retry's
  // options on to the real one and keeps them.
  const delays = new Map<string, number | undefined>()
  const messages = batch.messages.map(
    (message) =>
      new Proxy(message, {
        get(target, property) {
          if (property === 'retry') {
            return (options?: QueueRetryOptions) => {
              delays.set(target.id, options?.delaySeconds)
              target.retry(options)
            }
          }
          const value = Reflect.get(target, property, target) as unknown
          return typeof value === 'function' ? value.bind(target) : value
        },
      }),
  )
  const seen = new Proxy(batch, {
    get(target, property) {
      if (property === 'messages') return messages
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  await asSystemAt(
    runtime,
    time,
    'deliver',
    Effect.flatMap(Webhooks, (w) => w.consume(seen)),
  )
  const result = await getQueueResult(batch, ctx)
  return {
    ...result,
    retryMessages: result.retryMessages.map((m) => ({
      ...m,
      delaySeconds: delays.get(m.msgId),
    })),
    ids,
  }
}

/** The sweep at `time`. */
export const sweepAt = (runtime: CoreRuntime, time: number) =>
  asSystemAt(
    runtime,
    time,
    'sweep',
    Effect.flatMap(Webhooks, (w) => w.sweep()),
  )

/** A Webhooks call, for runAs. */
export const webhooks = <A, E>(
  use: (w: WebhooksService) => Effect.Effect<A, E, CurrentCaller>,
) => Effect.flatMap(Webhooks, use)
