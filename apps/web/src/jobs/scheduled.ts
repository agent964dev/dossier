// The Worker's scheduled jobs: the weekly purge and the five-minute webhook
// sweep. Each run is a SystemJob of its own, which no request ever holds.
import { Effect } from 'effect'

import {
  CurrentCaller,
  Purge,
  Webhooks,
  type CoreRuntime,
} from '../core/index.ts'
import { newId } from '../core/ids.ts'
import { SystemJob } from '../core/system-store.ts'

/** Sunday 03:17 UTC, as `triggers.crons` in wrangler.jsonc names it. */
export const WEEKLY_PURGE = '17 3 * * SUN'

/** Every five minutes: deliveries a lost message or a Queue outage left. */
export const WEBHOOK_SWEEP = '*/5 * * * *'

const weeklyPurge = async (runtime: CoreRuntime) => {
  const runId = newId()
  const exit = await runtime.runPromiseExit(
    Effect.flatMap(Purge, (purge) => purge.run('weekly')).pipe(
      Effect.provideService(SystemJob, { job: 'purge', runId }),
    ),
  )
  if (exit._tag === 'Failure') {
    // A running purge is fine: the weekly run comes again next week.
    console.error('The weekly purge did not run to its end', {
      runId,
      cause: String(exit.cause),
    })
  }
}

const webhookSweep = async (runtime: CoreRuntime) => {
  const runId = newId()
  await runtime.runPromise(
    Effect.flatMap(Webhooks, (webhooks) => webhooks.sweep()).pipe(
      Effect.provideService(SystemJob, { job: 'sweep', runId }),
      Effect.provideService(CurrentCaller, {
        person: null,
        via: { kind: 'system', job: 'sweep' },
        requestId: runId,
      }),
    ),
  )
}

/** Runs the job a cron names, and logs one that names nothing known. */
export const runScheduled = async (
  controller: Pick<ScheduledController, 'cron'>,
  runtime: CoreRuntime,
): Promise<void> => {
  switch (controller.cron) {
    case WEEKLY_PURGE:
      return weeklyPurge(runtime)
    case WEBHOOK_SWEEP:
      return webhookSweep(runtime)
    default:
      console.warn('No job runs on this schedule', { cron: controller.cron })
  }
}
