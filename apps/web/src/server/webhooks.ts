import type { EventType } from '@dossier/contracts'
import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import { Webhooks, type WebhookId } from '../core/index.ts'
import { runScreen } from './run.ts'
import { webhooksModel } from './webhooks-model.ts'

export type { WebhooksView } from './webhooks-model.ts'

const workspaceOf = (input: { readonly workspace: string }) => ({
  workspace: String(input.workspace),
})

/** Event names as typed; Webhooks refuses any it does not send. */
const eventsOf = (events: unknown): EventType[] =>
  Array.isArray(events) ? events.map((e) => String(e) as EventType) : []

export const webhooksView = createServerFn({ method: 'GET' })
  .validator(workspaceOf)
  .handler(({ data }) => runScreen(webhooksModel(data.workspace)))

export const createWebhook = createServerFn({ method: 'POST' })
  .validator(
    (input: {
      readonly workspace: string
      readonly url: string
      readonly events: readonly string[]
    }) => ({
      workspace: String(input.workspace),
      url: String(input.url),
      events: eventsOf(input.events),
    }),
  )
  .handler(({ data }) =>
    runScreen(Effect.flatMap(Webhooks, (w) => w.create(data))),
  )

export const updateWebhook = createServerFn({ method: 'POST' })
  .validator(
    (input: {
      readonly workspace: string
      readonly id: string
      readonly url: string
      readonly events: readonly string[]
    }) => ({
      workspace: String(input.workspace),
      id: String(input.id) as WebhookId,
      url: String(input.url),
      events: eventsOf(input.events),
    }),
  )
  .handler(({ data }) =>
    runScreen(Effect.flatMap(Webhooks, (w) => w.update(data))),
  )

const webhookOf = (input: {
  readonly workspace: string
  readonly id: string
}) => ({
  ...workspaceOf(input),
  id: String(input.id) as WebhookId,
})

export const rollWebhookSecret = createServerFn({ method: 'POST' })
  .validator(webhookOf)
  .handler(({ data }) =>
    runScreen(Effect.flatMap(Webhooks, (w) => w.rollSecret(data))),
  )

export const removeWebhook = createServerFn({ method: 'POST' })
  .validator(webhookOf)
  .handler(({ data }) =>
    runScreen(Effect.flatMap(Webhooks, (w) => w.remove(data))),
  )
