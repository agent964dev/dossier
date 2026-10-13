import { Schema } from 'effect'

/** The one list of event types: watch, webhooks and history read these. */
export const EventTypeSchema = Schema.Literal(
  'push',
  'delete',
  'restore',
  'move',
  'submission',
  'entry',
  'withdrawal',
  'data_write',
  'comment',
  'mention',
  'share',
)
export type EventType = typeof EventTypeSchema.Type
