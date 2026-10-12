// The Worker's scheduled jobs. The weekly purge is the only one; each run is
// a SystemJob of its own, which no request ever holds.
import { Effect } from 'effect'

import { Purge, type CoreRuntime } from '../core/index.ts'
import { newId } from '../core/ids.ts'
import { SystemJob } from '../core/system-store.ts'

/** Sunday 03:17 UTC, as `triggers.crons` in wrangler.jsonc names it. */
export const WEEKLY_PURGE = '17 3 * * SUN'

/** Runs the job a cron names, and logs one that names nothing known. */
export const runScheduled = async (
  controller: Pick<ScheduledController, 'cron'>,
  runtime: CoreRuntime,
): Promise<void> => {
  if (controller.cron !== WEEKLY_PURGE) {
    console.warn('No job runs on this schedule', { cron: controller.cron })
    return
  }
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
