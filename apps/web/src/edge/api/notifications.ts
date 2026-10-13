import { DossierApi } from '@dossier/contracts'
import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'

import { Notifications } from '../../core/index.ts'

/**
 * The caller's own notifications: every one for Dossier's screens, or one
 * tree's for a page, which its shell names.
 */
export const NotificationsApiLive = HttpApiBuilder.group(
  DossierApi,
  'notifications',
  (handlers) =>
    handlers
      .handle('list', ({ urlParams }) =>
        Effect.gen(function* () {
          const page = yield* (yield* Notifications).list({
            before: urlParams.before ?? null,
            limit: urlParams.limit,
            tree: urlParams.tree ?? null,
          })
          return {
            notifications: page.notifications.map((n) => ({
              ...n,
              at: new Date(n.at).toISOString(),
            })),
            unread: page.unread,
            next: page.next,
          }
        }),
      )
      .handle('read', ({ payload }) =>
        Effect.gen(function* () {
          const tree = payload.tree ?? null
          const unread = yield* (yield* Notifications).markRead(
            'all' in payload ? { all: true, tree } : { ids: payload.ids, tree },
          )
          return { unread }
        }),
      ),
)
