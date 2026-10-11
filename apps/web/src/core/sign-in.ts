import {
  dossierError,
  fail,
  type AgentKeyId,
  type AgentKeySecret,
  type DeviceToken,
  type DossierError,
  type LinkRef,
  type Me,
  type NodeId,
  type Person,
  type PersonId,
  type SessionId,
} from '@dossier/contracts'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { Clock, Context, Effect, Layer, Redacted } from 'effect'

import { db, schema } from '../db/client.ts'
import { Auth, type AuthHooks, type AuthPort } from '../ports/auth.ts'
import { Access } from './access.ts'
import { Bindings } from './bindings.ts'
import { CurrentCaller } from './caller.ts'
import { Config } from './config.ts'
import { hmacSha256, newId, newKeySecret, sha256Hex } from './ids.ts'
import { TreeStore } from './tree-store.ts'
import {
  authorityOf,
  decideEmailChange,
  decideLink,
  type Authority,
} from './sign-in-rules.ts'

export interface BrowserSession {
  readonly person: Person
  readonly sessionId: SessionId
  /** The account that opened the session. */
  readonly googleAccountId: string | null
  readonly setCookie: readonly string[]
}

export interface AgentPrincipal {
  readonly person: Person
  readonly key: {
    readonly id: AgentKeyId
    readonly name: string
    readonly scope: NodeId | null
    readonly readOnly: boolean
  }
}

export interface AgentKeyView {
  readonly id: AgentKeyId
  readonly name: string
  /** What the key is limited to, as `agent964/acme/`; null for everything. */
  readonly reach: string | null
  readonly readOnly: boolean
  readonly lastUsedAt: number | null
  readonly createdAt: number
}

/** What a new key can reach: the whole account, or one node and below. */
export type KeyReach =
  | { readonly kind: 'everything' }
  | { readonly kind: 'node'; readonly ref: LinkRef }

export interface DevicePrompt {
  readonly name: string
  readonly deployment: string
  readonly expiresAt: number
}

/** What the sign-in screen shows after Dossier refused or adjusted a sign-in. */
export type SignInNotice =
  | { readonly kind: 'email_unconfirmed'; readonly email: string }
  | { readonly kind: 'email_in_use'; readonly email: string }

export interface SignInService {
  /** Better Auth's routes under /_/auth, inside Dossier's rules. */
  readonly handle: (request: Request) => Effect.Effect<Response>
  readonly session: (
    headers: Headers,
  ) => Effect.Effect<BrowserSession | null, DossierError<'unavailable'>>
  /** Moves the key's last use at most once a minute. */
  readonly agent: (
    secret: string,
  ) => Effect.Effect<AgentPrincipal | null, DossierError<'unavailable'>>
  /** Reads a notice from the signed value in a sign-in redirect. */
  readonly notice: (
    kind: string | null,
    signed: string | null,
  ) => Effect.Effect<SignInNotice | null>
  readonly me: () => Effect.Effect<
    Me,
    DossierError<'sign_in_required' | 'unavailable'>,
    CurrentCaller
  >
  readonly devicePrompt: (
    userCode: string,
  ) => Effect.Effect<
    DevicePrompt,
    DossierError<'sign_in_required' | 'device_expired' | 'unavailable'>,
    CurrentCaller
  >
  readonly approveDevice: (
    userCode: string,
  ) => Effect.Effect<
    void,
    DossierError<'sign_in_required' | 'device_expired' | 'unavailable'>,
    CurrentCaller
  >
  readonly denyDevice: (
    userCode: string,
  ) => Effect.Effect<
    void,
    DossierError<'sign_in_required' | 'device_expired' | 'unavailable'>,
    CurrentCaller
  >
  readonly redeemDevice: (
    deviceCode: string,
  ) => Effect.Effect<
    DeviceToken,
    DossierError<
      | 'device_pending'
      | 'slow_down'
      | 'device_expired'
      | 'access_denied'
      | 'unavailable'
    >
  >
  readonly keys: () => Effect.Effect<
    readonly AgentKeyView[],
    DossierError<'sign_in_required' | 'unavailable'>,
    CurrentCaller
  >
  readonly createKey: (i: {
    readonly name: string
    readonly reach: KeyReach
    readonly readOnly: boolean
  }) => Effect.Effect<
    { readonly secret: AgentKeySecret; readonly key: AgentKeyView },
    DossierError<'sign_in_required' | 'invalid' | 'not_found' | 'unavailable'>,
    CurrentCaller
  >
  readonly revokeKey: (
    id: AgentKeyId | 'current',
  ) => Effect.Effect<
    void,
    DossierError<'sign_in_required' | 'not_found' | 'unavailable'>,
    CurrentCaller
  >
  /** Ends every browser session of the person; agent keys keep working. */
  readonly signOutEverywhere: () => Effect.Effect<
    void,
    DossierError<'sign_in_required' | 'unavailable'>,
    CurrentCaller
  >
}

export class SignIn extends Context.Tag('SignIn')<SignIn, SignInService>() {}

const KEY_USE_GRANULARITY = 60_000
const NOTICE_LIFETIME = 10 * 60_000
const KEY_NAME_MAX = 64

const unavailable = () => dossierError('unavailable')

const query = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => {
      console.error('D1 query failed', error)
      return unavailable()
    },
  })

const signedInPerson = Effect.flatMap(CurrentCaller, (caller) =>
  caller.person === null
    ? fail(
        'sign_in_required',
        'Sign in to continue.',
        'Sign in with Google, or run dossier login.',
      )
    : Effect.succeed({ person: caller.person, via: caller.via }),
)

const toKeyView = (row: {
  id: string
  name: string
  readOnly: boolean
  lastUsedAt: number | null
  createdAt: number
  workspace: string | null
  tree: string | null
  path: string | null
  kind: string | null
}): AgentKeyView => ({
  id: row.id as AgentKeyId,
  name: row.name,
  reach: reachOf(row),
  readOnly: row.readOnly,
  lastUsedAt: row.lastUsedAt,
  createdAt: row.createdAt,
})

/** `agent964/acme/` for a folder, `agent964/acme/plan.html` for a file. */
const reachOf = (row: {
  workspace: string | null
  tree: string | null
  path: string | null
  kind: string | null
}): string | null => {
  if (row.workspace === null || row.tree === null || row.path === null) {
    return null
  }
  const at = [row.workspace, row.tree, row.path]
    .filter((part) => part !== '')
    .join('/')
  return row.kind === 'folder' ? `${at}/` : at
}

const encodeNotice = (value: unknown): string =>
  btoa(JSON.stringify(value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')

const decodeNotice = (value: string): unknown => {
  try {
    return JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/')))
  } catch {
    return null
  }
}

export const SignInLive: Layer.Layer<
  SignIn,
  never,
  Auth | Bindings | Config | TreeStore | Access
> = Layer.effect(
  SignIn,
  Effect.gen(function* () {
    const makeAuth = yield* Auth
    const bindings = yield* Bindings
    const config = yield* Config
    const store = yield* TreeStore
    const access = yield* Access
    const clock = yield* Effect.clock
    const database = db(bindings)
    const noticeSecret = `${Redacted.value(config.betterAuthSecret)}:sign-in-notice`

    const now = () => clock.unsafeCurrentTimeMillis()

    const accountsOf = async (userId: string) =>
      database
        .select({
          accountId: schema.account.id,
          authority: schema.googleAccounts.emailAuthority,
        })
        .from(schema.account)
        .leftJoin(
          schema.googleAccounts,
          eq(schema.googleAccounts.accountId, schema.account.id),
        )
        .where(eq(schema.account.userId, userId))
        .all()

    const toAuthority = (value: string | null): Authority =>
      value === 'google' ? 'google' : 'none'

    const hooks: AuthHooks = {
      beforeAccount: async ({ action, claims, existingUserId }) => {
        if (action === 'create-user' || existingUserId === null) {
          return { allow: true }
        }
        if (action === 'link-account') {
          const existing = await accountsOf(existingUserId)
          const decision = decideLink(
            authorityOf(claims),
            existing.map((a) => ({
              accountId: a.accountId,
              authority: toAuthority(a.authority),
            })),
          )
          return decision.kind === 'refuse'
            ? { allow: false, code: 'email_unconfirmed', email: claims.email }
            : { allow: true }
        }
        const stored = await database
          .select({ email: schema.user.email })
          .from(schema.user)
          .where(eq(schema.user.id, existingUserId))
          .get()
        if (stored === undefined || stored.email === claims.email) {
          return { allow: true }
        }
        const holder = await database
          .select({ id: schema.user.id })
          .from(schema.user)
          .where(eq(schema.user.email, claims.email))
          .get()
        return decideEmailChange(
          claims.email,
          (holder?.id as PersonId | undefined) ?? null,
          existingUserId as PersonId,
        ) === 'keep-old'
          ? { allow: true, keepEmail: stored.email }
          : { allow: true }
      },

      afterLink: async ({ userId, accountId, claims }) => {
        const others = (await accountsOf(userId)).filter(
          (a) => a.accountId !== accountId,
        )
        const decision = decideLink(
          authorityOf(claims),
          others.map((a) => ({
            accountId: a.accountId,
            authority: toAuthority(a.authority),
          })),
        )
        const detached = decision.kind === 'link' ? decision.takeover : []
        const at = now()
        const linked = database.insert(schema.personHistory).values({
          id: newId(),
          userId,
          kind: 'linked',
          detailJson: JSON.stringify({ accountId }),
          createdAt: at,
        })
        if (detached.length === 0) {
          await linked.run()
          return
        }
        // One batch: the detached accounts lose everything they opened.
        await database.batch([
          linked,
          database
            .delete(schema.session)
            .where(
              and(
                eq(schema.session.userId, userId),
                inArray(schema.session.googleAccountId, [...detached]),
              ),
            ),
          database
            .update(schema.agentKeys)
            .set({ revokedAt: at })
            .where(
              and(
                eq(schema.agentKeys.userId, userId),
                inArray(schema.agentKeys.googleAccountId, [...detached]),
                isNull(schema.agentKeys.revokedAt),
              ),
            ),
          database
            .update(schema.deviceCode)
            .set({ status: 'denied' })
            .where(
              and(
                inArray(schema.deviceCode.approvedByGoogleAccountId, [
                  ...detached,
                ]),
                eq(schema.deviceCode.status, 'approved'),
              ),
            ),
          database
            .delete(schema.googleAccounts)
            .where(inArray(schema.googleAccounts.accountId, [...detached])),
          database
            .delete(schema.account)
            .where(
              and(
                eq(schema.account.userId, userId),
                inArray(schema.account.id, [...detached]),
              ),
            ),
          database.insert(schema.personHistory).values({
            id: newId(),
            userId,
            kind: 'takeover',
            detailJson: JSON.stringify({ by: accountId, detached }),
            createdAt: at,
          }),
        ])
      },

      afterSignIn: async ({
        userId,
        accountId,
        claims,
        newUser,
        emailKept,
      }) => {
        const at = now()
        const authority = authorityOf(claims)
        const seedSuperAdmin = newUser && config.superAdmins.has(claims.email)
        await database.batch([
          database
            .insert(schema.googleAccounts)
            .values({
              accountId,
              email: claims.email,
              emailAuthority: authority,
              hostedDomain: claims.hd ?? null,
              observedAt: at,
            })
            .onConflictDoUpdate({
              target: schema.googleAccounts.accountId,
              set: {
                email: claims.email,
                emailAuthority: authority,
                hostedDomain: claims.hd ?? null,
                observedAt: at,
              },
            }),
          database
            .insert(schema.people)
            .values({
              userId,
              emailAuthority: authority,
              firstSignInAt: at,
              lastSignInAt: at,
            })
            .onConflictDoUpdate({
              target: schema.people.userId,
              set: { emailAuthority: authority, lastSignInAt: at },
            }),
          ...(seedSuperAdmin
            ? [
                database
                  .insert(schema.superAdmins)
                  .values({ userId, addedBy: null, createdAt: at })
                  .onConflictDoNothing(),
              ]
            : []),
          ...(emailKept === null
            ? []
            : [
                database.insert(schema.personHistory).values({
                  id: newId(),
                  userId,
                  kind: 'email_kept',
                  detailJson: JSON.stringify({ accountId, ...emailKept }),
                  createdAt: at,
                }),
              ]),
        ])
      },
    }

    const auth: AuthPort = makeAuth(hooks)

    const signNotice = async (kind: string, email: string) => {
      const payload = encodeNotice({
        k: kind,
        e: email,
        x: now() + NOTICE_LIFETIME,
      })
      return `${payload}.${await hmacSha256(noticeSecret, payload)}`
    }

    /** Points Better Auth's redirect at Dossier's own notice on the sign-in screen. */
    const withNotice = async (
      response: Response,
      kind: 'email_unconfirmed' | 'email_in_use',
      email: string,
    ): Promise<Response> => {
      const location = response.headers.get('location')
      if (location === null) return response
      const target = new URL('/_/sign-in', config.origin)
      target.searchParams.set(
        kind === 'email_unconfirmed' ? 'error' : 'notice',
        kind,
      )
      target.searchParams.set('who', await signNotice(kind, email))
      // Keep where the person was going: Better Auth's success redirect, or
      // the next its error redirect carries.
      const redirect = new URL(location, config.origin)
      const next =
        kind === 'email_in_use'
          ? `${redirect.pathname}${redirect.search}`
          : redirect.searchParams.get('next')
      if (redirect.origin === config.origin.origin && next !== null) {
        target.searchParams.set('next', next)
      }
      const headers = new Headers(response.headers)
      headers.set('location', target.href)
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    }

    const findKey = (userId: string, id: string) =>
      query(() =>
        database
          .select({ id: schema.agentKeys.id })
          .from(schema.agentKeys)
          .where(
            and(
              eq(schema.agentKeys.id, id),
              eq(schema.agentKeys.userId, userId),
              isNull(schema.agentKeys.revokedAt),
            ),
          )
          .get(),
      )

    const revoke = (userId: string, id: string) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        yield* query(() =>
          database.batch([
            database
              .update(schema.agentKeys)
              .set({ revokedAt: at })
              .where(
                and(
                  eq(schema.agentKeys.id, id),
                  eq(schema.agentKeys.userId, userId),
                  isNull(schema.agentKeys.revokedAt),
                ),
              ),
            database.insert(schema.personHistory).values({
              id: newId(),
              userId,
              kind: 'key_revoked',
              detailJson: JSON.stringify({ keyId: id }),
              createdAt: at,
            }),
          ]),
        )
      })

    /** The person's live keys, or one of them, with what each reaches. */
    const keyRows = (userId: string, id: AgentKeyId | null) =>
      query(() =>
        database
          .select({
            id: schema.agentKeys.id,
            name: schema.agentKeys.name,
            readOnly: schema.agentKeys.readOnly,
            lastUsedAt: schema.agentKeys.lastUsedAt,
            createdAt: schema.agentKeys.createdAt,
            workspace: schema.workspaces.name,
            tree: schema.trees.name,
            path: schema.nodes.path,
            kind: schema.nodes.kind,
          })
          .from(schema.agentKeys)
          .leftJoin(
            schema.nodes,
            eq(schema.nodes.id, schema.agentKeys.scopeNodeId),
          )
          .leftJoin(schema.trees, eq(schema.trees.id, schema.nodes.treeId))
          .leftJoin(
            schema.workspaces,
            eq(schema.workspaces.id, schema.trees.workspaceId),
          )
          .where(
            and(
              eq(schema.agentKeys.userId, userId),
              isNull(schema.agentKeys.revokedAt),
              ...(id === null ? [] : [eq(schema.agentKeys.id, id)]),
            ),
          )
          .orderBy(desc(schema.agentKeys.createdAt))
          .all(),
      ).pipe(Effect.map((rows) => rows.map(toKeyView)))

    const personById = (userId: string) =>
      query(() =>
        database
          .select({
            id: schema.user.id,
            email: schema.user.email,
            name: schema.user.name,
            image: schema.user.image,
          })
          .from(schema.user)
          .where(eq(schema.user.id, userId))
          .get(),
      ).pipe(
        Effect.map((row): Person | null =>
          row === undefined
            ? null
            : { ...row, id: row.id as PersonId, image: row.image ?? null },
        ),
      )

    const service: SignInService = {
      handle: (request) =>
        Effect.promise(async () => {
          const { response, outcome } = await auth.handle(request)
          if (outcome.refused !== null) {
            return withNotice(
              response,
              'email_unconfirmed',
              outcome.refused.email,
            )
          }
          if (outcome.emailKept !== null && response.status === 302) {
            return withNotice(
              response,
              'email_in_use',
              outcome.emailKept.attempted,
            )
          }
          return response
        }),

      session: (headers) =>
        auth.getSession(headers).pipe(
          Effect.map((found) =>
            found === null
              ? null
              : {
                  person: found.person,
                  sessionId: found.sessionId,
                  googleAccountId: found.googleAccountId,
                  setCookie: found.setCookie,
                },
          ),
        ),

      agent: (secret) =>
        Effect.gen(function* () {
          if (!secret.startsWith('dsk_')) return null
          const hash = yield* Effect.promise(() => sha256Hex(secret))
          const row = yield* query(() =>
            database
              .select({
                id: schema.agentKeys.id,
                name: schema.agentKeys.name,
                scope: schema.agentKeys.scopeNodeId,
                readOnly: schema.agentKeys.readOnly,
                lastUsedAt: schema.agentKeys.lastUsedAt,
                userId: schema.user.id,
                email: schema.user.email,
                personName: schema.user.name,
                image: schema.user.image,
              })
              .from(schema.agentKeys)
              .innerJoin(
                schema.user,
                eq(schema.user.id, schema.agentKeys.userId),
              )
              .where(
                and(
                  eq(schema.agentKeys.hashSha256, hash),
                  isNull(schema.agentKeys.revokedAt),
                ),
              )
              .get(),
          )
          if (row === undefined) return null
          const at = yield* Clock.currentTimeMillis
          if (
            row.lastUsedAt === null ||
            at - row.lastUsedAt >= KEY_USE_GRANULARITY
          ) {
            yield* query(() =>
              database
                .update(schema.agentKeys)
                .set({ lastUsedAt: at })
                .where(eq(schema.agentKeys.id, row.id))
                .run(),
            )
          }
          return {
            person: {
              id: row.userId as PersonId,
              email: row.email,
              name: row.personName,
              image: row.image ?? null,
            },
            key: {
              id: row.id as AgentKeyId,
              name: row.name,
              scope: row.scope as NodeId | null,
              readOnly: row.readOnly,
            },
          }
        }),

      notice: (kind, signed) =>
        Effect.promise(async (): Promise<SignInNotice | null> => {
          if (
            signed === null ||
            (kind !== 'email_unconfirmed' && kind !== 'email_in_use')
          ) {
            return null
          }
          const [payload = '', signature = ''] = signed.split('.')
          if (signature !== (await hmacSha256(noticeSecret, payload)))
            return null
          const value = decodeNotice(payload) as {
            k?: unknown
            e?: unknown
            x?: unknown
          } | null
          if (
            value === null ||
            value.k !== kind ||
            typeof value.e !== 'string' ||
            typeof value.x !== 'number' ||
            value.x < now()
          ) {
            return null
          }
          return { kind, email: value.e }
        }),

      me: () =>
        Effect.gen(function* () {
          const { person, via } = yield* signedInPerson
          if (via.kind !== 'agent') {
            return { person, deployment: config.deploymentName, key: null }
          }
          const [key] = yield* keyRows(person.id, via.keyId)
          return {
            person,
            deployment: config.deploymentName,
            key:
              key === undefined
                ? null
                : {
                    id: key.id,
                    name: key.name,
                    scope: key.reach,
                    readOnly: key.readOnly,
                  },
          }
        }),

      devicePrompt: (userCode) =>
        Effect.gen(function* () {
          const { person } = yield* signedInPerson
          const view = yield* auth.viewDevice(userCode, person.id)
          return {
            name: view.name,
            deployment: config.deploymentName,
            expiresAt: view.expiresAt,
          }
        }),

      approveDevice: (userCode) =>
        Effect.gen(function* () {
          const { person, via } = yield* signedInPerson
          const googleAccountId =
            via.kind === 'browser'
              ? ((yield* query(() =>
                  database
                    .select({ id: schema.session.googleAccountId })
                    .from(schema.session)
                    .where(eq(schema.session.id, via.sessionId))
                    .get(),
                ))?.id ?? null)
              : null
          yield* auth.viewDevice(userCode, person.id)
          yield* auth.approveDevice(userCode, person.id, googleAccountId)
        }),

      denyDevice: (userCode) =>
        Effect.gen(function* () {
          const { person } = yield* signedInPerson
          yield* auth.viewDevice(userCode, person.id)
          yield* auth.denyDevice(userCode, person.id)
        }),

      redeemDevice: (deviceCode) =>
        Effect.gen(function* () {
          const redemption = yield* auth.redeemDeviceCode(deviceCode)
          switch (redemption.status) {
            case 'pending':
              return yield* fail(
                'device_pending',
                'Waiting for the code to be confirmed in the browser.',
              )
            case 'slow_down':
              return yield* fail('slow_down', 'Polling too fast; wait longer.')
            case 'expired':
              return yield* fail(
                'device_expired',
                'This code expired.',
                'Run dossier login again.',
              )
            case 'denied':
              return yield* fail(
                'access_denied',
                'The sign-in was denied in the browser.',
                'Run dossier login again.',
              )
          }
          const refused = fail(
            'access_denied',
            'The Google account that approved this sign-in no longer belongs to this person.',
            'Run dossier login again.',
          )
          const approver = redemption.approvedByGoogleAccountId
          if (approver === null) return yield* refused
          // The code is spent from here on: a failure means starting again.
          const minted = yield* Effect.gen(function* () {
            const secret = newKeySecret()
            const hash = yield* Effect.promise(() => sha256Hex(secret))
            const keyId = newId()
            const at = yield* Clock.currentTimeMillis
            // The approving account must still belong to the person when the
            // key is written; a takeover in between detached it.
            const stillTheirs =
              'exists (select 1 from account where id = ? and user_id = ?)'
            const [inserted] = yield* Effect.tryPromise(() =>
              bindings.DB.batch([
                bindings.DB.prepare(
                  `insert into agent_keys (id, user_id, name, hash_sha256, created_via, google_account_id, created_at)
                     select ?, ?, ?, ?, 'device', ?, ? where ${stillTheirs}`,
                ).bind(
                  keyId,
                  redemption.userId,
                  redemption.deviceName,
                  hash,
                  approver,
                  at,
                  approver,
                  redemption.userId,
                ),
                bindings.DB.prepare(
                  `insert into person_history (id, user_id, kind, detail_json, created_at)
                     select ?, ?, 'key_created', ?, ? where ${stillTheirs}`,
                ).bind(
                  newId(),
                  redemption.userId,
                  JSON.stringify({ keyId, via: 'device' }),
                  at,
                  approver,
                  redemption.userId,
                ),
              ]),
            )
            if (inserted === undefined)
              return yield* Effect.die('D1 returned no result')
            return { secret, written: inserted.meta.changes === 1 }
          }).pipe(
            Effect.catchAll((error) =>
              Effect.logError('Minting a device key failed', error).pipe(
                Effect.zipRight(
                  fail(
                    'device_expired',
                    'This code expired.',
                    'Run dossier login again.',
                  ),
                ),
              ),
            ),
          )
          if (!minted.written) return yield* refused
          const person = yield* personById(redemption.userId)
          if (person === null) return yield* refused
          return {
            key: minted.secret,
            name: redemption.deviceName,
            deployment: config.deploymentName,
            person,
          }
        }),

      keys: () =>
        Effect.gen(function* () {
          const { person } = yield* signedInPerson
          return yield* keyRows(person.id, null)
        }),

      createKey: ({ name, reach, readOnly }) =>
        Effect.gen(function* () {
          const { person, via } = yield* signedInPerson
          const trimmed = name.trim()
          if (trimmed === '' || trimmed.length > KEY_NAME_MAX) {
            return yield* fail(
              'invalid',
              `A key name has 1 to ${KEY_NAME_MAX} characters.`,
              'Choose a shorter name.',
              'name',
            )
          }
          const googleAccountId =
            via.kind === 'browser'
              ? ((yield* query(() =>
                  database
                    .select({ id: schema.session.googleAccountId })
                    .from(schema.session)
                    .where(eq(schema.session.id, via.sessionId))
                    .get(),
                ))?.id ?? null)
              : null
          // A key reaches only what its person can open when it is made.
          let scopeNodeId: NodeId | null = null
          if (reach.kind === 'node') {
            const resolved = yield* store.resolve(reach.ref)
            const granted = yield* access
              .require('read', 'missing' in resolved ? resolved : resolved.node)
              .pipe(
                Effect.catchAll(() =>
                  fail(
                    'not_found',
                    'Nothing at that path is yours to open.',
                    'Choose a tree or path you can open.',
                    'reach',
                  ),
                ),
              )
            scopeNodeId = granted.id
          }
          const secret = newKeySecret()
          const hash = yield* Effect.promise(() => sha256Hex(secret))
          const at = yield* Clock.currentTimeMillis
          const key = {
            id: newId(),
            userId: person.id,
            name: trimmed,
            hashSha256: hash,
            createdVia: 'settings',
            googleAccountId,
            scopeNodeId,
            readOnly,
            lastUsedAt: null,
            revokedAt: null,
            createdAt: at,
          }
          yield* query(() =>
            database.batch([
              database.insert(schema.agentKeys).values(key),
              database.insert(schema.personHistory).values({
                id: newId(),
                userId: person.id,
                kind: 'key_created',
                detailJson: JSON.stringify({
                  keyId: key.id,
                  via: 'settings',
                  scope: scopeNodeId,
                  readOnly,
                }),
                createdAt: at,
              }),
            ]),
          )
          const [view] = yield* keyRows(person.id, key.id as AgentKeyId)
          if (view === undefined) return yield* Effect.die('key not stored')
          return { secret, key: view }
        }),

      revokeKey: (id) =>
        Effect.gen(function* () {
          const { person, via } = yield* signedInPerson
          if (id === 'current') {
            if (via.kind !== 'agent') {
              return yield* fail(
                'sign_in_required',
                'Only an agent key can revoke itself.',
                'Send the request with the key to revoke.',
              )
            }
            return yield* revoke(person.id, via.keyId)
          }
          const found = yield* findKey(person.id, id)
          if (found === undefined) {
            return yield* fail('not_found', 'No such agent key.')
          }
          yield* revoke(person.id, id)
        }),

      signOutEverywhere: () =>
        Effect.gen(function* () {
          const { person } = yield* signedInPerson
          yield* auth.revokeUserSessions(person.id)
          const at = yield* Clock.currentTimeMillis
          yield* query(() =>
            database
              .insert(schema.personHistory)
              .values({
                id: newId(),
                userId: person.id,
                kind: 'signed_out_everywhere',
                detailJson: '{}',
                createdAt: at,
              })
              .run(),
          )
        }),
    }
    return service
  }),
)
