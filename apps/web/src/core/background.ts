import { Cause, Context, Effect, Layer } from 'effect'

/** Work after a response: the request never waits for it. */
export interface BackgroundService {
  readonly run: (work: Effect.Effect<void>) => Effect.Effect<void>
}

export class Background extends Context.Tag('Background')<
  Background,
  BackgroundService
>() {}

/** A failure of background work is logged and dropped. */
const logged = (work: Effect.Effect<void>): Effect.Effect<void> =>
  work.pipe(
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        console.error('Background work failed', Cause.pretty(cause))
      }),
    ),
  )

/** The Worker's adapter: the work runs under the request's waitUntil. */
export const backgroundFor = (
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): BackgroundService => ({
  run: (work) =>
    Effect.sync(() => {
      ctx.waitUntil(Effect.runPromise(logged(work)))
    }),
})

/** Tests, and anywhere no response waits: the work finishes before run returns. */
export const backgroundInline: BackgroundService = {
  run: (work) => logged(work),
}

export const BackgroundInline: Layer.Layer<Background> = Layer.succeed(
  Background,
  backgroundInline,
)
