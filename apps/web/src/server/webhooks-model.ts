// The Webhooks tab's read model, apart from its server functions so the
// Worker tests can call it.
import type { EventType } from '@dossier/contracts'
import { Effect } from 'effect'

import { WEBHOOK_EVENTS, Webhooks, type WebhookView } from '../core/index.ts'

export interface WebhooksView {
  readonly workspace: string
  /** The workspace's limit now. */
  readonly limit: number
  readonly eventTypes: readonly EventType[]
  readonly webhooks: readonly (WebhookView & {
    /** "Failing since 10 Oct 14:02 · HTTP 500", or null. */
    readonly status: string | null
  })[]
}

const WHEN = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
})

/** '10 Oct 14:02', in UTC. */
export const failingWhen = (at: number): string =>
  WHEN.format(new Date(at)).replace(/,| at/g, '')

export const statusOf = (webhook: WebhookView): string | null =>
  webhook.failing === null
    ? null
    : `Failing since ${failingWhen(webhook.failing.since)} · ${webhook.failing.lastError}`

export const webhooksModel = (workspace: string) =>
  Effect.gen(function* () {
    const { webhooks, limit } = yield* Effect.flatMap(Webhooks, (w) =>
      w.list(workspace),
    )
    return {
      workspace,
      limit,
      eventTypes: WEBHOOK_EVENTS,
      webhooks: webhooks.map((webhook) => ({
        ...webhook,
        status: statusOf(webhook),
      })),
    } satisfies WebhooksView
  })
