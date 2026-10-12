// Webhooks: what workspace admins register, and how each event reaches them.
// A commit's Queue message fans out into one delivery row and one message per
// webhook that takes the event; each delivery is signed with Standard
// Webhooks headers, rechecked before it goes, and retried with backoff. The
// sweep closes the gaps a lost message or a Queue outage leaves. A webhook
// acts as its workspace and never as a person: its deliveries are a system
// job, and the rechecks are their whole access rule.
import {
  dossierError,
  EventTypeSchema,
  linkFor,
  type DossierError,
  type EventSeq,
  type EventType,
  type TreeId,
  type WorkspaceId,
} from '@dossier/contracts'
import { Clock, Context, Effect, Layer } from 'effect'

import { Access } from './access.ts'
import { Bindings } from './bindings.ts'
import { CurrentCaller } from './caller.ts'
import { Config } from './config.ts'
import { newId } from './ids.ts'
import { Settings } from './settings.ts'
import {
  SystemJob,
  type EventInWorkspace,
  type SystemStore,
} from './system-store.ts'
import { TreeStore } from './tree-store.ts'
import { webhookUrl, type WebhookUrlRules } from './webhook-url.ts'
import { newWebhookSecret, signWebhook } from './webhook-signing.ts'

export type WebhookId = string & { readonly WebhookId: unique symbol }

export type WebhookMessage =
  | {
      readonly kind: 'events'
      readonly treeId: TreeId
      readonly fromSeq: EventSeq
      readonly toSeq: EventSeq
    }
  | {
      readonly kind: 'deliver'
      readonly treeId: TreeId
      readonly seq: EventSeq
      readonly webhookId: WebhookId
    }

/** The wait after each failed attempt: nine attempts over about 22 hours. */
export const RETRY_DELAYS_SECONDS: readonly number[] = [
  30, 120, 600, 1800, 3600, 10800, 21600, 43200,
]

/** Attempts before a delivery has failed for good. */
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1

/** Consecutive failures before "Failing since" shows. */
export const FAILING_AFTER = 3

/** How long a receiver has to answer. */
export const DELIVERY_TIMEOUT_MS = 10_000

/** The event types a webhook may take, in the order Dossier lists them. */
export const WEBHOOK_EVENTS: readonly EventType[] = EventTypeSchema.literals

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

/** How far back the sweep looks for events with no delivery. */
export const SWEEP_WINDOW_MS = DAY
/** Events the sweep reads at most in one run. */
export const SWEEP_EVENTS = 5000
/** A pending delivery whose attempt is this late has lost its message. */
export const STUCK_AFTER_MS = 10 * MINUTE
/** A running attempt holds its delivery this long, so no other runs it. */
const LEASE_MS = MINUTE
/**
 * An attempt sends only while this much of its lease is left: the request's
 * own timeout and time to record what came of it.
 */
const SEND_MARGIN_MS = DELIVERY_TIMEOUT_MS + 15 * 1000
/** The longest delay a Queue message may be given. */
const MAX_DELAY_SECONDS = 43200
/** A retry message may arrive this much before its delivery is due. */
const EARLY_MS = 15 * 1000
/** Pending deliveries the sweep sends again at most in one run. */
const STUCK_BATCH = 1000
/** Old delivery rows one sweep deletes at most. */
const RETENTION_BATCH = 5000
/** Messages one sendBatch call takes at most. */
const SEND_BATCH = 100

export interface WebhookView {
  readonly id: WebhookId
  readonly url: string
  readonly events: readonly EventType[]
  readonly createdAt: number
  /** Set once FAILING_AFTER attempts in a row have failed. */
  readonly failing: {
    readonly since: number
    readonly lastError: string
  } | null
  readonly lastSuccessAt: number | null
}

export interface WebhooksService {
  readonly list: (
    workspace: string,
  ) => Effect.Effect<
    { readonly webhooks: readonly WebhookView[]; readonly limit: number },
    DossierError<'sign_in_required' | 'not_found' | 'forbidden'>,
    CurrentCaller
  >
  /** The secret is in this answer and in rollSecret's, and nowhere else. */
  readonly create: (i: {
    readonly workspace: string
    readonly url: string
    readonly events: readonly EventType[]
  }) => Effect.Effect<
    { readonly webhook: WebhookView; readonly secret: string },
    DossierError<
      'sign_in_required' | 'not_found' | 'forbidden' | 'invalid' | 'too_large'
    >,
    CurrentCaller
  >
  readonly update: (i: {
    readonly workspace: string
    readonly id: WebhookId
    readonly url: string
    readonly events: readonly EventType[]
  }) => Effect.Effect<
    WebhookView,
    DossierError<'sign_in_required' | 'not_found' | 'forbidden' | 'invalid'>,
    CurrentCaller
  >
  readonly rollSecret: (i: {
    readonly workspace: string
    readonly id: WebhookId
  }) => Effect.Effect<
    { readonly secret: string },
    DossierError<'sign_in_required' | 'not_found' | 'forbidden'>,
    CurrentCaller
  >
  readonly remove: (i: {
    readonly workspace: string
    readonly id: WebhookId
  }) => Effect.Effect<
    void,
    DossierError<'sign_in_required' | 'not_found' | 'forbidden'>,
    CurrentCaller
  >
  /** The Queue's batch; job 'deliver'. Every message is acked or retried. */
  readonly consume: (
    batch: MessageBatch<WebhookMessage>,
  ) => Effect.Effect<void, never, CurrentCaller | SystemJob>
  /** Every five minutes; job 'sweep'. */
  readonly sweep: () => Effect.Effect<void, never, CurrentCaller | SystemJob>
}

export class Webhooks extends Context.Tag('Webhooks')<
  Webhooks,
  WebhooksService
>() {}

interface WebhookRow {
  readonly id: WebhookId
  readonly workspaceId: WorkspaceId
  readonly url: string
  readonly eventsJson: string
  readonly secret: string
  readonly createdAt: number
  readonly failingSince: number | null
  readonly consecutiveFailures: number
  readonly lastError: string | null
  readonly lastSuccessAt: number | null
}

const WEBHOOK_COLUMNS = `id, workspace_id as workspaceId, url,
  events_json as eventsJson, secret, created_at as createdAt,
  failing_since as failingSince, consecutive_failures as consecutiveFailures,
  last_error as lastError, last_success_at as lastSuccessAt`

const eventsOf = (json: string): readonly EventType[] => {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed)
      ? WEBHOOK_EVENTS.filter((type) => parsed.includes(type))
      : []
  } catch {
    return []
  }
}

const viewOf = (row: WebhookRow): WebhookView => ({
  id: row.id,
  url: row.url,
  events: eventsOf(row.eventsJson),
  createdAt: row.createdAt,
  failing:
    row.consecutiveFailures >= FAILING_AFTER && row.failingSince !== null
      ? { since: row.failingSince, lastError: row.lastError ?? 'failed' }
      : null,
  lastSuccessAt: row.lastSuccessAt,
})

const BAD_URL = 'Use an https URL on another host.'

/** The URL a webhook may keep, or `invalid`. */
const urlOf = (input: string, rules: WebhookUrlRules) => {
  const url = webhookUrl(input, rules)
  return url === null
    ? Effect.fail(
        dossierError(
          'invalid',
          BAD_URL,
          'A webhook sends over https to a public host other than this deployment.',
          'url',
        ),
      )
    : Effect.succeed(url)
}

/** The events chosen, each one Dossier sends, in Dossier's order. */
const chosenEvents = (input: readonly unknown[]) => {
  const unknown = input.find(
    (type) =>
      typeof type !== 'string' || !WEBHOOK_EVENTS.includes(type as EventType),
  )
  if (unknown !== undefined) {
    return Effect.fail(
      dossierError(
        'invalid',
        `${String(unknown)} is not an event Dossier sends.`,
        `Choose from ${WEBHOOK_EVENTS.join(', ')}.`,
        'events',
      ),
    )
  }
  const events = WEBHOOK_EVENTS.filter((type) => input.includes(type))
  return events.length === 0
    ? Effect.fail(
        dossierError('invalid', 'Choose at least one event.', null, 'events'),
      )
    : Effect.succeed(events)
}

/** What one attempt came to. */
type Attempt =
  | { readonly ok: true; readonly status: number }
  | {
      readonly ok: false
      readonly status: number | null
      /** As the Webhooks tab shows it. */
      readonly error: string
    }

/** Sends one delivery; never follows a redirect and never reads the body. */
const attempt = (
  url: string,
  init: { readonly body: string; readonly headers: Record<string, string> },
): Effect.Effect<Attempt> =>
  Effect.promise(async (): Promise<Attempt> => {
    try {
      // Read at call time: tests install their receiver over it.
      const response = await globalThis.fetch(url, {
        method: 'POST',
        body: init.body,
        headers: init.headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      })
      await response.body?.cancel().catch(() => undefined)
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, status: response.status }
      }
      if (response.status >= 300 && response.status < 400) {
        return {
          ok: false,
          status: response.status,
          error: 'redirect not followed',
        }
      }
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`,
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      return {
        ok: false,
        status: null,
        error:
          name === 'TimeoutError' || name === 'AbortError'
            ? `timed out after ${DELIVERY_TIMEOUT_MS / 1000} s`
            : 'could not connect',
      }
    }
  })

type DeliverMessage = Extract<WebhookMessage, { kind: 'deliver' }>
type DeliveryKey = Pick<DeliverMessage, 'treeId' | 'seq' | 'webhookId'>

export const WebhooksLive: Layer.Layer<
  Webhooks,
  never,
  Bindings | Config | Access | TreeStore | Settings
> = Layer.effect(
  Webhooks,
  Effect.gen(function* () {
    const env = yield* Bindings
    const config = yield* Config
    const access = yield* Access
    const store = yield* TreeStore
    const settings = yield* Settings
    const { DB } = env
    const rules: WebhookUrlRules = {
      origin: config.origin,
      contentHost: config.contentHost,
    }

    const unavailable = (what: string) => (error: unknown) => {
      console.error(`Webhooks could not ${what}`, error)
      return dossierError('unavailable')
    }
    const query = <A>(what: string, run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: unavailable(what) })
    /** A screen read or write: D1 down is the plain error page. */
    const screenQuery = <A>(what: string, run: () => Promise<A>) =>
      query(what, run).pipe(Effect.orDie)

    // Admins.

    /**
     * The workspace when the caller administers it in a browser. A member
     * is refused; anyone else learns nothing.
     */
    const adminOf = (name: string) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const workspace = yield* store.workspace(name)
        const membership = yield* access.member(workspace)
        if (caller.person === null || caller.via.kind !== 'browser') {
          return yield* Effect.fail(
            dossierError('not_found', undefined, null, name),
          )
        }
        if (membership.role !== 'admin') {
          return yield* Effect.fail(
            dossierError(
              'forbidden',
              `Only admins of ${membership.workspace.name} manage its webhooks.`,
              null,
              name,
            ),
          )
        }
        return {
          workspace: membership.workspace,
          personId: caller.person.id,
          sessionId: caller.via.sessionId,
        }
      })

    type Admin = Effect.Effect.Success<ReturnType<typeof adminOf>>

    /**
     * Runs statements only if, as the batch commits, the session lives and
     * its person still administers the live, unsuspended workspace.
     */
    const adminBatch = (
      ctx: Admin,
      statements: readonly D1PreparedStatement[],
    ): Effect.Effect<D1Result[], DossierError<'not_found'>> =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        const guardId = newId()
        const results = yield* Effect.tryPromise({
          try: () =>
            DB.batch([
              DB.prepare(
                `insert into change_guards (id, reason, ok)
                 select ?, 'basis', coalesce((
                   exists (select 1 from session
                     where id = ? and user_id = ? and expires_at > ?)
                   and exists (select 1 from workspace_members m
                     join workspaces w on w.id = m.workspace_id
                     where m.workspace_id = ? and m.user_id = ? and m.role = 'admin'
                       and w.deleted_at is null and w.suspended_at is null)), 0)`,
              ).bind(
                guardId,
                ctx.sessionId,
                ctx.personId,
                at,
                ctx.workspace.id,
                ctx.personId,
              ),
              ...statements,
              DB.prepare('delete from change_guards where id = ?').bind(
                guardId,
              ),
            ]),
          catch: (error) => error,
        }).pipe(
          Effect.catchAll((error) =>
            String(error instanceof Error ? error.message : error).includes(
              'change_guard_basis',
            )
              ? Effect.fail(
                  dossierError(
                    'not_found',
                    undefined,
                    null,
                    ctx.workspace.name,
                  ),
                )
              : Effect.die(unavailable('save a webhook')(error)),
          ),
        )
        return results.slice(1, -1)
      })

    const gone = (workspace: string) =>
      dossierError('not_found', 'This webhook is gone.', null, workspace)

    const rowIn = (ctx: Admin, id: WebhookId) =>
      screenQuery('read a webhook', () =>
        DB.prepare(
          `select ${WEBHOOK_COLUMNS} from webhooks where id = ? and workspace_id = ?`,
        )
          .bind(String(id), ctx.workspace.id)
          .first<WebhookRow>(),
      ).pipe(
        Effect.flatMap((row) =>
          row === null
            ? Effect.fail(gone(ctx.workspace.name))
            : Effect.succeed(row),
        ),
      )

    const limitNow = settings.current().pipe(
      Effect.map((s) => s.limits.webhooksPerWorkspace),
      Effect.orDie,
    )

    const list: WebhooksService['list'] = (name) =>
      Effect.gen(function* () {
        const ctx = yield* adminOf(name)
        const rows = yield* screenQuery('list webhooks', () =>
          DB.prepare(
            `select ${WEBHOOK_COLUMNS} from webhooks where workspace_id = ?
             order by created_at, id`,
          )
            .bind(ctx.workspace.id)
            .all<WebhookRow>(),
        )
        return { webhooks: rows.results.map(viewOf), limit: yield* limitNow }
      })

    const changes = (result: D1Result | undefined) => result?.meta.changes ?? 0

    const create: WebhooksService['create'] = (i) =>
      Effect.gen(function* () {
        const ctx = yield* adminOf(i.workspace)
        const url = yield* urlOf(i.url, rules)
        const events = yield* chosenEvents(i.events)
        const limit = yield* limitNow
        const id = newId() as WebhookId
        const secret = newWebhookSecret()
        const at = yield* Clock.currentTimeMillis
        const eventsJson = JSON.stringify(events)
        // The count is taken in the batch, so two admins adding at once
        // never pass the limit together.
        const [inserted] = yield* adminBatch(ctx, [
          DB.prepare(
            `insert into webhooks (id, workspace_id, url, events_json, secret,
               created_by, created_at)
             select ?1, ?2, ?3, ?4, ?5, ?6, ?7
             where (select count(*) from webhooks where workspace_id = ?2) < ?8`,
          ).bind(
            id,
            ctx.workspace.id,
            url,
            eventsJson,
            secret,
            ctx.personId,
            at,
            limit,
          ),
        ])
        if (changes(inserted) === 0) {
          return yield* Effect.fail(
            dossierError(
              'too_large',
              `This workspace has ${limit} webhooks, its limit. A super admin can raise it.`,
              'Delete a webhook first, or ask a super admin to raise the limit.',
              ctx.workspace.name,
            ),
          )
        }
        return {
          webhook: viewOf({
            id,
            workspaceId: ctx.workspace.id,
            url,
            eventsJson,
            secret,
            createdAt: at,
            failingSince: null,
            consecutiveFailures: 0,
            lastError: null,
            lastSuccessAt: null,
          }),
          secret,
        }
      })

    const update: WebhooksService['update'] = (i) =>
      Effect.gen(function* () {
        const ctx = yield* adminOf(i.workspace)
        yield* rowIn(ctx, i.id)
        const url = yield* urlOf(i.url, rules)
        const events = yield* chosenEvents(i.events)
        // Another URL is another receiver: its record of failures starts over.
        const [changed] = yield* adminBatch(ctx, [
          DB.prepare(
            `update webhooks set
               failing_since = case when url = ?1 then failing_since else null end,
               consecutive_failures = case when url = ?1 then consecutive_failures else 0 end,
               last_error = case when url = ?1 then last_error else null end,
               last_error_at = case when url = ?1 then last_error_at else null end,
               url = ?1, events_json = ?2
             where id = ?3 and workspace_id = ?4`,
          ).bind(url, JSON.stringify(events), String(i.id), ctx.workspace.id),
        ])
        if (changes(changed) === 0) {
          return yield* Effect.fail(gone(ctx.workspace.name))
        }
        return viewOf(yield* rowIn(ctx, i.id))
      })

    const rollSecret: WebhooksService['rollSecret'] = (i) =>
      Effect.gen(function* () {
        const ctx = yield* adminOf(i.workspace)
        yield* rowIn(ctx, i.id)
        const secret = newWebhookSecret()
        const [changed] = yield* adminBatch(ctx, [
          DB.prepare(
            'update webhooks set secret = ? where id = ? and workspace_id = ?',
          ).bind(secret, String(i.id), ctx.workspace.id),
        ])
        if (changes(changed) === 0) {
          return yield* Effect.fail(gone(ctx.workspace.name))
        }
        return { secret }
      })

    const remove: WebhooksService['remove'] = (i) =>
      Effect.gen(function* () {
        const ctx = yield* adminOf(i.workspace)
        yield* rowIn(ctx, i.id)
        // Its deliveries go with it.
        yield* adminBatch(ctx, [
          DB.prepare(
            'delete from webhooks where id = ? and workspace_id = ?',
          ).bind(String(i.id), ctx.workspace.id),
        ])
      })

    // Deliveries.

    /** Webhooks of these workspaces, for matching events to them. */
    const hooksOf = (workspaces: readonly string[]) =>
      workspaces.length === 0
        ? Effect.succeed([] as WebhookRow[])
        : query('read webhooks', () =>
            DB.prepare(
              `select ${WEBHOOK_COLUMNS} from webhooks
               where workspace_id in (select value from json_each(?))`,
            )
              .bind(JSON.stringify([...new Set(workspaces)]))
              .all<WebhookRow>(),
          ).pipe(Effect.map((rows) => rows.results))

    /** Each (event, webhook) where the webhook takes the event. */
    const pairsOf = (
      events: readonly EventInWorkspace[],
      hooks: readonly WebhookRow[],
    ) => {
      const taken = new Map(hooks.map((h) => [h.id, eventsOf(h.eventsJson)]))
      return events.flatMap((e) =>
        hooks
          .filter(
            (h) =>
              h.workspaceId === e.workspaceId &&
              h.createdAt <= e.createdAt &&
              (taken.get(h.id) ?? []).includes(e.type as EventType),
          )
          .map((h) => ({ t: e.treeId, s: e.seq, w: h.id })),
      )
    }

    /** Writes the pairs' rows as pending; the ones that were new. */
    const insertPending = (
      pairs: readonly { t: string; s: number; w: string }[],
      at: number,
    ) =>
      Effect.gen(function* () {
        const fresh: DeliveryKey[] = []
        for (let from = 0; from < pairs.length; from += 500) {
          const rows = yield* query('record deliveries', () =>
            DB.prepare(
              `insert into webhook_deliveries (event_tree_id, event_seq, webhook_id,
                 state, attempts, next_at, created_at)
               select json_extract(p.value, '$.t'), json_extract(p.value, '$.s'),
                 json_extract(p.value, '$.w'), 'pending', 0, ?2, ?2
               from json_each(?1) p
               where exists (select 1 from webhooks w
                 where w.id = json_extract(p.value, '$.w'))
               on conflict do nothing
               returning event_tree_id as treeId, event_seq as seq,
                 webhook_id as webhookId`,
            )
              .bind(JSON.stringify(pairs.slice(from, from + 500)), at)
              .all<DeliveryKey>(),
          )
          fresh.push(...rows.results)
        }
        return fresh
      })

    /** One 'deliver' message per delivery, at most 100 a call. */
    const sendDeliveries = (rows: readonly DeliveryKey[]) =>
      Effect.gen(function* () {
        const queue = env.WEBHOOKS
        if (rows.length === 0) return
        if (queue === undefined) {
          return yield* Effect.fail(
            unavailable('reach the Queue')('no WEBHOOKS binding'),
          )
        }
        for (let from = 0; from < rows.length; from += SEND_BATCH) {
          const chunk = rows.slice(from, from + SEND_BATCH)
          yield* query('send to the Queue', () =>
            queue.sendBatch(
              chunk.map((r) => ({
                body: {
                  kind: 'deliver',
                  treeId: r.treeId,
                  seq: r.seq,
                  webhookId: r.webhookId,
                } satisfies WebhookMessage,
              })),
            ),
          )
        }
      })

    /** A commit's events: a delivery row and a message per webhook taking each. */
    const fanOut = (
      system: SystemStore,
      m: Extract<WebhookMessage, { kind: 'events' }>,
    ) =>
      Effect.gen(function* () {
        const events = yield* system.eventsInRange(m.treeId, m.fromSeq, m.toSeq)
        if (events.length === 0) return
        const hooks = yield* hooksOf(events.map((e) => e.workspaceId))
        const pairs = pairsOf(events, hooks)
        if (pairs.length === 0) return
        const at = yield* Clock.currentTimeMillis
        // Messages lost after the rows are written are found by the sweep.
        yield* sendDeliveries(yield* insertPending(pairs, at))
      })

    /** Marks a delivery skipped, sending nothing. */
    const skip = (m: DeliveryKey, why: string) =>
      Effect.gen(function* () {
        console.log(
          JSON.stringify({
            message: 'webhook skipped',
            webhook: m.webhookId,
            tree: m.treeId,
            seq: m.seq,
            why,
          }),
        )
        yield* query('skip a delivery', () =>
          DB.prepare(
            `update webhook_deliveries set state = 'skipped', claim_id = null,
               claimed_until = null
             where event_tree_id = ? and event_seq = ? and webhook_id = ?
               and state = 'pending'`,
          )
            .bind(m.treeId, m.seq, m.webhookId)
            .run(),
        )
      })

    const keyBinds = (m: DeliveryKey) => [m.treeId, m.seq, m.webhookId] as const

    /** Lets a claim go early, so a retry need not wait out its lease. */
    const release = (m: DeliveryKey, claimId: string) =>
      query('release a delivery', () =>
        DB.prepare(
          `update webhook_deliveries set claim_id = null, claimed_until = null
           where event_tree_id = ? and event_seq = ? and webhook_id = ?
             and claim_id = ?`,
        )
          .bind(...keyBinds(m), claimId)
          .run(),
      ).pipe(Effect.ignore)

    /**
     * One delivery: claimed, rechecked, signed, sent, and recorded. Only the
     * attempt holding the claim sends, and only it records what came of it.
     */
    const deliver = (
      system: SystemStore,
      message: Message<WebhookMessage>,
      m: DeliverMessage,
    ) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const claimId = newId()
        const claimed = yield* query('claim a delivery', () =>
          DB.prepare(
            `update webhook_deliveries set claim_id = ?1, claimed_until = ?2
             where event_tree_id = ?3 and event_seq = ?4 and webhook_id = ?5
               and state = 'pending' and next_at <= ?6
               and (claimed_until is null or claimed_until <= ?7)
             returning attempts`,
          )
            .bind(claimId, now + LEASE_MS, ...keyBinds(m), now + EARLY_MS, now)
            .first<{ attempts: number }>(),
        )
        if (claimed === null) {
          const row = yield* query('read a delivery', () =>
            DB.prepare(
              `select state, next_at as nextAt, claimed_until as claimedUntil
               from webhook_deliveries
               where event_tree_id = ? and event_seq = ? and webhook_id = ?`,
            )
              .bind(...keyBinds(m))
              .first<{
                state: string
                nextAt: number
                claimedUntil: number | null
              }>(),
          )
          // Done, failed for good, skipped or gone: a repeated message.
          if (row === null || row.state !== 'pending') return message.ack()
          // Held by another attempt, or not due yet: back when it may run.
          const until = Math.max(row.nextAt, row.claimedUntil ?? 0)
          return message.retry({
            delaySeconds: Math.min(
              MAX_DELAY_SECONDS,
              Math.max(1, Math.ceil((until - now) / 1000) + 1),
            ),
          })
        }
        return yield* attemptClaimed(system, message, m, {
          claimId,
          claimedAt: now,
          attempts: claimed.attempts,
        }).pipe(
          // A try that could not finish lets its claim go for the retry.
          Effect.tapErrorCause(() => release(m, claimId)),
        )
      })

    const attemptClaimed = (
      system: SystemStore,
      message: Message<WebhookMessage>,
      m: DeliverMessage,
      claim: {
        readonly claimId: string
        readonly claimedAt: number
        readonly attempts: number
      },
    ) =>
      Effect.gen(function* () {
        const hook = yield* query('read a webhook', () =>
          DB.prepare(`select ${WEBHOOK_COLUMNS} from webhooks where id = ?`)
            .bind(m.webhookId)
            .first<WebhookRow>(),
        )
        if (hook === null) {
          yield* skip(m, 'webhook gone')
          return message.ack()
        }
        // One read of the event, its tree and the workspace it is in now:
        // the rechecks below rest on the same moment.
        const facts = yield* system.eventForDelivery(m.treeId, m.seq)
        if (facts === null) {
          yield* skip(m, 'event gone')
          return message.ack()
        }
        if (facts.tree.workspaceId !== hook.workspaceId) {
          yield* skip(m, 'tree moved')
          return message.ack()
        }
        if (
          facts.workspace.deletedAt !== null ||
          facts.workspace.suspendedAt !== null
        ) {
          yield* skip(m, 'workspace not live')
          return message.ack()
        }
        const type = facts.event.type as EventType
        if (!eventsOf(hook.eventsJson).includes(type)) {
          yield* skip(m, 'event no longer chosen')
          return message.ack()
        }
        const url = webhookUrl(hook.url, rules)
        if (url === null) {
          yield* skip(m, 'url refused')
          return message.ack()
        }
        const pushId = facts.event.pushId
        const push =
          pushId === null
            ? null
            : yield* query('read a push', () =>
                DB.prepare('select number from pushes where id = ?')
                  .bind(pushId)
                  .first<{ number: number }>(),
              ).pipe(Effect.map((row) => row?.number ?? null))
        const at = new Date(facts.event.createdAt).toISOString()
        // The envelope and the event as the events route gives it: nothing
        // about nodes, people or shares beyond that.
        const body = JSON.stringify({
          type,
          timestamp: at,
          data: {
            deployment: config.deploymentName,
            workspace: facts.workspace.name,
            tree: { id: facts.tree.id, name: facts.tree.name },
            event: {
              seq: facts.event.seq,
              type,
              path: facts.event.path,
              at,
              by: facts.actorEmail,
              push,
            },
            link: linkFor(config.origin, {
              workspace: facts.workspace.name,
              tree: facts.tree.name,
              path: facts.event.path,
              kind: facts.linkKind,
            }),
          },
        })
        const id = `evt_${m.treeId}_${m.seq}`
        const sending = yield* Clock.currentTimeMillis
        // A request that could outlast the claim waits for another try, so
        // no other attempt can send while this one still might.
        if (sending + SEND_MARGIN_MS > claim.claimedAt + LEASE_MS) {
          return yield* Effect.fail(
            dossierError('unavailable', 'The claim ran short before sending.'),
          )
        }
        const timestamp = Math.floor(sending / 1000)
        const signature = yield* signWebhook({
          secret: hook.secret,
          id,
          timestamp,
          body,
        })
        const result = yield* attempt(url, {
          body,
          headers: {
            'content-type': 'application/json',
            'user-agent': 'Dossier-Webhooks/1',
            'webhook-id': id,
            'webhook-timestamp': String(timestamp),
            'webhook-signature': signature,
          },
        })
        const done = yield* Clock.currentTimeMillis
        const attempts = claim.attempts + 1
        console.log(
          JSON.stringify({
            message: 'webhook delivery',
            webhook: m.webhookId,
            workspace: facts.workspace.name,
            tree: m.treeId,
            seq: m.seq,
            type,
            attempt: attempts,
            ok: result.ok,
            status: result.status,
            error: result.ok ? null : result.error,
          }),
        )
        const last = !result.ok && attempts >= MAX_ATTEMPTS
        const delay = RETRY_DELAYS_SECONDS[attempts - 1] ?? 0
        const recorded = yield* query('record a delivery', () =>
          DB.prepare(
            `update webhook_deliveries set attempts = ?1, last_status = ?2,
               last_error = ?3, state = ?4, next_at = ?5, delivered_at = ?6,
               claim_id = null, claimed_until = null
             where event_tree_id = ?7 and event_seq = ?8 and webhook_id = ?9
               and claim_id = ?10 and state = 'pending'
             returning attempts`,
          )
            .bind(
              attempts,
              result.status,
              result.ok ? null : result.error,
              result.ok ? 'delivered' : last ? 'failed' : 'pending',
              result.ok || last ? done : done + delay * 1000,
              result.ok ? done : null,
              ...keyBinds(m),
              claim.claimId,
            )
            .first(),
        )
        // The claim was lost meanwhile: whoever holds it now records.
        if (recorded === null) return message.ack()
        // Health belongs to the receiver the request went to: an attempt
        // at a URL since edited away says nothing about the new one.
        yield* query('record a webhook’s health', () =>
          (result.ok
            ? DB.prepare(
                `update webhooks set failing_since = null, consecutive_failures = 0,
                   last_success_at = ?1 where id = ?2 and url = ?3`,
              ).bind(done, m.webhookId, hook.url)
            : DB.prepare(
                `update webhooks set consecutive_failures = consecutive_failures + 1,
                   failing_since = coalesce(failing_since, ?1), last_error = ?2,
                   last_error_at = ?1 where id = ?3 and url = ?4`,
              ).bind(done, result.error, m.webhookId, hook.url)
          ).run(),
        )
        if (result.ok || last) return message.ack()
        return message.retry({ delaySeconds: delay })
      })

    const consume: WebhooksService['consume'] = (batch) =>
      Effect.gen(function* () {
        const system = yield* store.system
        yield* Effect.forEach(
          batch.messages,
          (message) => {
            const body = message.body
            const work =
              body.kind === 'events'
                ? fanOut(system, body).pipe(Effect.andThen(() => message.ack()))
                : deliver(system, message, body)
            // Work that could not finish comes back later; its rows say
            // where it got to.
            return work.pipe(
              Effect.catchAllCause((cause) =>
                Effect.sync(() => {
                  console.error('A webhook message will be tried again', {
                    body,
                    cause: String(cause),
                  })
                  message.retry({ delaySeconds: RETRY_DELAYS_SECONDS[0] })
                }),
              ),
            )
          },
          { concurrency: 'unbounded', discard: true },
        )
      })

    const keyOf = (r: DeliveryKey) => `${r.treeId}|${r.seq}|${r.webhookId}`

    const sweep: WebhooksService['sweep'] = () =>
      Effect.gen(function* () {
        const system = yield* store.system
        const now = yield* Clock.currentTimeMillis
        const events = yield* system.eventsSince(
          now - SWEEP_WINDOW_MS,
          SWEEP_EVENTS,
        )
        const hooks = yield* hooksOf(events.map((e) => e.workspaceId))
        const missing = yield* insertPending(pairsOf(events, hooks), now)
        const late = yield* query('read late deliveries', () =>
          DB.prepare(
            `select event_tree_id as treeId, event_seq as seq,
               webhook_id as webhookId
             from webhook_deliveries
             where state = 'pending' and next_at < ?1
               and (claimed_until is null or claimed_until <= ?2)
             order by next_at limit ?3`,
          )
            .bind(now - STUCK_AFTER_MS, now, STUCK_BATCH)
            .all<DeliveryKey>(),
        ).pipe(Effect.map((rows) => rows.results))
        const { retentionDays } = yield* settings.current()
        yield* query('delete old deliveries', () =>
          DB.prepare(
            `delete from webhook_deliveries where rowid in (
               select rowid from webhook_deliveries where created_at < ? limit ?)`,
          )
            .bind(now - retentionDays * DAY, RETENTION_BATCH)
            .run(),
        )
        const fresh = new Set(missing.map(keyOf))
        yield* sendDeliveries([
          ...missing,
          ...late.filter((r) => !fresh.has(keyOf(r))),
        ])
        console.log(
          JSON.stringify({
            message: 'webhook sweep',
            missing: missing.length,
            late: late.length,
          }),
        )
      }).pipe(
        // The Queue or D1 down: rows stay pending, and the next run tries
        // again.
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            console.error(
              'The webhook sweep stopped; the next run tries again',
              String(cause),
            )
          }),
        ),
      )

    return {
      list,
      create,
      update,
      rollSecret,
      remove,
      consume,
      sweep,
    } satisfies WebhooksService
  }),
)
