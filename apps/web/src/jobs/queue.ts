// The webhook Queue's consumer. Each batch is a system job of its own: the
// caller is the deployment's delivery job, never a person.
import { Effect } from 'effect'

import {
  CurrentCaller,
  runtimeFor,
  Webhooks,
  type CoreRuntime,
  type WebhookMessage,
} from '../core/index.ts'
import { newId } from '../core/ids.ts'
import { SystemJob } from '../core/system-store.ts'

/** Hands the batch to Webhooks.consume, which acks or retries every message. */
export const runQueue = async (
  batch: MessageBatch<WebhookMessage>,
  runtime: CoreRuntime,
): Promise<void> => {
  const runId = newId()
  const exit = await runtime.runPromiseExit(
    Effect.flatMap(Webhooks, (webhooks) => webhooks.consume(batch)).pipe(
      Effect.provideService(SystemJob, { job: 'deliver', runId }),
      Effect.provideService(CurrentCaller, {
        person: null,
        via: { kind: 'system', job: 'deliver' },
        requestId: runId,
      }),
    ),
  )
  if (exit._tag === 'Failure') {
    // Nothing was acked: the Queue sends the batch again.
    console.error('A webhook batch failed', {
      runId,
      cause: String(exit.cause),
    })
    batch.retryAll({ delaySeconds: 30 })
  }
}

export const queue = (
  batch: MessageBatch<WebhookMessage>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> => runQueue(batch, runtimeFor(env))
