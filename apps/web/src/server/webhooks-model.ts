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
  readonly webhooks: readonly WebhookView[]
}

export const webhooksModel = (workspace: string) =>
  Effect.gen(function* () {
    const { webhooks, limit } = yield* Effect.flatMap(Webhooks, (w) =>
      w.list(workspace),
    )
    return {
      workspace,
      limit,
      eventTypes: WEBHOOK_EVENTS,
      webhooks,
    } satisfies WebhooksView
  })
