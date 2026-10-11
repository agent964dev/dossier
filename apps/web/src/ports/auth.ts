import { AsyncLocalStorage } from 'node:async_hooks'

import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import {
  dossierError,
  type DossierError,
  type Person,
  type PersonId,
  type SessionId,
} from '@dossier/contracts'
import type { BetterAuthOptions, BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint } from 'better-auth/api'
import { betterAuth } from 'better-auth/minimal'
import {
  deviceAuthorization,
  redeemDeviceCode,
  type DeviceAuthorizationGrant,
} from 'better-auth/plugins/device-authorization'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { Context, Effect, Layer, Redacted } from 'effect'
import * as z from 'zod'

import { Bindings } from '../core/bindings.ts'
import { Config, type DeploymentConfig } from '../core/config.ts'
import { db, schema } from '../db/client.ts'

/** The claims of a Google ID token Dossier reads. */
export interface GoogleClaims {
  readonly sub: string
  /** Lower-cased. */
  readonly email: string
  readonly email_verified: boolean
  readonly name: string
  readonly picture?: string
  /** The hosted domain of a Workspace account. */
  readonly hd?: string
}

/** What Better Auth is about to do with a Google sign-in. */
export type SignInAction = 'create-user' | 'link-account' | 'sign-in'

export type AccountDecision =
  | { readonly allow: true }
  /** Sign in, but keep the person's stored email rather than Google's new one. */
  | { readonly allow: true; readonly keepEmail: string }
  | {
      readonly allow: false
      readonly code: 'email_unconfirmed'
      readonly email: string
    }

/** Dossier's rules, run inside Better Auth's sign-in. */
export interface AuthHooks {
  /** Runs before Better Auth creates a person, links an account or signs in. */
  readonly beforeAccount: (i: {
    readonly action: SignInAction
    readonly claims: GoogleClaims
    readonly existingUserId: string | null
  }) => Promise<AccountDecision>
  /** Runs after a Google sign-in, before its session is written. */
  readonly afterSignIn: (i: {
    readonly userId: string
    readonly accountId: string
    readonly claims: GoogleClaims
    readonly newUser: boolean
    readonly emailKept: {
      readonly kept: string
      readonly attempted: string
    } | null
  }) => Promise<void>
}

/** What a sign-in request did besides answering, for the redirect Dossier shows. */
export interface SignInOutcome {
  readonly refused: {
    readonly code: 'email_unconfirmed'
    readonly email: string
  } | null
  readonly emailKept: {
    readonly kept: string
    readonly attempted: string
  } | null
}

export interface SessionLookup {
  readonly sessionId: SessionId
  readonly person: Person
  /** The account that opened the session. */
  readonly googleAccountId: string | null
  /** The renewal cookies, when the session was renewed. */
  readonly setCookie: readonly string[]
}

export interface DeviceView {
  readonly name: string
  readonly expiresAt: number
}

export type DeviceRedemption =
  | { readonly status: 'pending' | 'slow_down' | 'expired' | 'denied' }
  | {
      readonly status: 'approved'
      readonly userId: string
      readonly deviceCodeId: string
      readonly deviceName: string
      readonly approvedByGoogleAccountId: string | null
    }

export interface AuthPort {
  /** Better Auth's routes under /_/auth. */
  readonly handle: (
    request: Request,
  ) => Promise<{ readonly response: Response; readonly outcome: SignInOutcome }>
  readonly getSession: (
    headers: Headers,
  ) => Effect.Effect<SessionLookup | null, DossierError<'unavailable'>>
  readonly revokeUserSessions: (
    userId: PersonId,
  ) => Effect.Effect<void, DossierError<'unavailable'>>
  /**
   * Binds a pending code to the first signed-in person who opens it, and
   * reads it. A code bound to someone else looks expired.
   */
  readonly viewDevice: (
    userCode: string,
    userId: PersonId,
  ) => Effect.Effect<DeviceView, DossierError<'device_expired' | 'unavailable'>>
  /** `googleAccountId`: the approving session's account, stored on the code. */
  readonly approveDevice: (
    userCode: string,
    userId: PersonId,
    googleAccountId: string | null,
  ) => Effect.Effect<void, DossierError<'device_expired' | 'unavailable'>>
  readonly denyDevice: (
    userCode: string,
    userId: PersonId,
  ) => Effect.Effect<void, DossierError<'device_expired' | 'unavailable'>>
  /** Claims an approved code once, atomically. */
  readonly redeemDeviceCode: (
    deviceCode: string,
  ) => Effect.Effect<DeviceRedemption, DossierError<'unavailable'>>
}

export class Auth extends Context.Tag('Auth')<
  Auth,
  (hooks: AuthHooks) => AuthPort
>() {}

export const DEVICE_CLIENT = 'dossier-cli'
export const DEVICE_SCOPE = 'agent-key'
const GRANT_KIND = 'dossier-agent-key'
const THIRTY_DAYS = 60 * 60 * 24 * 30

interface SignInScope {
  action?: SignInAction
  claims?: GoogleClaims
  keepEmail?: string
  refused?: { code: 'email_unconfirmed'; email: string }
  emailKept?: { kept: string; attempted: string }
}

const scopes = new AsyncLocalStorage<SignInScope>()

const claimsFrom = (profile: Record<string, unknown>): GoogleClaims => {
  const hd = typeof profile.hd === 'string' ? profile.hd.toLowerCase() : ''
  const picture = typeof profile.picture === 'string' ? profile.picture : ''
  const email = String(profile.email ?? '').toLowerCase()
  return {
    sub: String(profile.sub ?? ''),
    email,
    email_verified: profile.email_verified === true,
    name: typeof profile.name === 'string' ? profile.name : email,
    ...(picture === '' ? {} : { picture }),
    ...(hd === '' ? {} : { hd }),
  }
}

const deviceGrant = {
  requestSchemaFields: { device_name: z.string().trim().min(1).max(64) },
  deviceCodeSchemaFields: {
    deviceName: { type: 'string', required: false, input: false },
    grantKind: { type: 'string', required: false, input: false },
    approvedByGoogleAccountId: {
      type: 'string',
      required: false,
      input: false,
    },
  },
  authorizeRequest: ({ request }) => {
    if (
      (request.client_id !== undefined &&
        request.client_id !== DEVICE_CLIENT) ||
      (request.scope !== undefined && request.scope !== DEVICE_SCOPE)
    ) {
      throw new APIError('BAD_REQUEST', {
        error: 'invalid_client',
        error_description: `Only ${DEVICE_CLIENT} may ask for a device code`,
      })
    }
    return {
      clientId: DEVICE_CLIENT,
      deviceCodeFields: {
        deviceName: request.device_name,
        grantKind: GRANT_KIND,
      },
    }
  },
  // The plugin's own token route would mint a browser session: refuse it.
  assertSessionRedemption: ({ deviceCode }) => {
    if (deviceCode.grantKind === GRANT_KIND) {
      throw new APIError('BAD_REQUEST', {
        error: 'invalid_grant',
        error_description: 'Redeem this code at /_/api/device/token',
      })
    }
  },
  getVerificationContext: (deviceCode) => ({
    device_name: String(deviceCode.deviceName ?? ''),
  }),
} satisfies DeviceAuthorizationGrant

const REDEMPTION_STATUS: Record<string, DeviceRedemption['status']> = {
  authorization_pending: 'pending',
  slow_down: 'slow_down',
  expired_token: 'expired',
  access_denied: 'denied',
  // Unknown, already claimed, or another client's code.
  invalid_grant: 'expired',
}

const errorCodeOf = (error: unknown): string | null => {
  if (!(error instanceof APIError)) return null
  const body = error.body as { error?: unknown; code?: unknown } | undefined
  return typeof body?.error === 'string' ? body.error : null
}

/** Dossier redeems its own codes on the server; nothing reaches it over HTTP. */
const deviceRedemption = {
  id: 'dossier-device-redemption',
  endpoints: {
    redeemDossierDeviceCode: createAuthEndpoint(
      '/dossier/device/redeem',
      {
        method: 'POST',
        body: z.object({ deviceCode: z.string() }),
        metadata: { SERVER_ONLY: true },
      },
      async (ctx) => {
        try {
          const { claimedDeviceCode, user } = await redeemDeviceCode<
            {
              deviceName?: string | null
              grantKind?: string | null
              approvedByGoogleAccountId?: string | null
            },
            undefined,
            undefined
          >({
            ctx,
            deviceCode: ctx.body.deviceCode,
            authorizeRedemption: (deviceCode) => {
              if (deviceCode.grantKind !== GRANT_KIND) {
                throw new APIError('BAD_REQUEST', { error: 'invalid_grant' })
              }
              return {
                ownershipWhere: { field: 'clientId', value: DEVICE_CLIENT },
                context: undefined,
              }
            },
            prepareRedemption: () => undefined,
          })
          return ctx.json({
            status: 'approved',
            userId: user.id,
            deviceCodeId: claimedDeviceCode.id,
            deviceName: claimedDeviceCode.deviceName ?? 'device',
            approvedByGoogleAccountId:
              claimedDeviceCode.approvedByGoogleAccountId ?? null,
          } satisfies DeviceRedemption)
        } catch (error) {
          const status = REDEMPTION_STATUS[errorCodeOf(error) ?? '']
          if (status === undefined) throw error
          return ctx.json({ status } as DeviceRedemption)
        }
      },
    ),
  },
} satisfies BetterAuthPlugin

/** The calls Dossier makes into Better Auth on the server. */
interface AuthApi {
  getSession: (i: { headers: Headers; returnHeaders: true }) => Promise<{
    headers: Headers
    response: {
      session: { id: string; googleAccountId?: string | null }
      user: { id: string; email: string; name: string; image?: string | null }
    } | null
  }>
  redeemDossierDeviceCode: (i: {
    body: { deviceCode: string }
  }) => Promise<DeviceRedemption>
}

const unavailable = () => dossierError('unavailable')

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => {
      console.error('Better Auth call failed', error)
      return unavailable()
    },
  })

const expired = () =>
  dossierError(
    'device_expired',
    'This code expired. Run dossier login again.',
    'Run dossier login again.',
  )

type Database = ReturnType<typeof db>

const subjectLookups = (database: Database) => {
  async function accountIdForSubject(sub: string): Promise<string | null> {
    const row = await database
      .select({ id: schema.account.id })
      .from(schema.account)
      .where(
        and(
          eq(schema.account.providerId, 'google'),
          eq(schema.account.accountId, sub),
        ),
      )
      .get()
    return row?.id ?? null
  }

  async function userIdForSubject(sub: string): Promise<string | null> {
    const row = await database
      .select({ userId: schema.account.userId })
      .from(schema.account)
      .where(
        and(
          eq(schema.account.providerId, 'google'),
          eq(schema.account.accountId, sub),
        ),
      )
      .get()
    return row?.userId ?? null
  }

  return { accountIdForSubject, userIdForSubject }
}

/**
 * Better Auth's options: Google and the device plugin, on D1 through Drizzle.
 * `extraPlugins` go before the cookie plugin, which must stay last.
 */
export const authOptions = (
  database: Database,
  config: DeploymentConfig,
  hooks: AuthHooks,
  extraPlugins: readonly BetterAuthPlugin[] = [],
) => {
  const origin = config.origin.origin
  const { accountIdForSubject, userIdForSubject } = subjectLookups(database)

  return {
    appName: config.deploymentName,
    basePath: '/_/auth',
    baseURL: config.origin.href,
    secret: Redacted.value(config.betterAuthSecret),
    // PUBLIC_ORIGIN, and the request's own origin, which Wrangler's local
    // HTTPS proxy turns into http.
    trustedOrigins: (request?: Request) =>
      request === undefined ? [origin] : [origin, new URL(request.url).origin],
    database: drizzleAdapter(database, {
      provider: 'sqlite',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        deviceCode: schema.deviceCode,
        rateLimit: schema.rateLimit,
      },
    }),
    socialProviders:
      config.google === null
        ? {}
        : {
            google: {
              clientId: config.google.clientId,
              clientSecret: Redacted.value(config.google.clientSecret),
              prompt: 'select_account',
              // The email follows Google at every sign-in.
              overrideUserInfoOnSignIn: true,
            },
          },
    account: {
      // Linking by email is on; Dossier's guard narrows it in validateUserInfo.
      accountLinking: { enabled: true, trustedProviders: [] },
    },
    user: {
      validateUserInfo: async ({ user, source }) => {
        if (source.method !== 'oauth' || source.oauth?.providerId !== 'google')
          return
        const scope = scopes.getStore()
        // A Google sign-in outside Dossier's scope could not be recorded.
        if (scope === undefined) return { error: 'unavailable' }
        const claims = claimsFrom(source.oauth.profile ?? {})
        scope.action = source.action
        scope.claims = claims
        const existingUserId =
          source.action === 'create-user'
            ? null
            : source.action === 'link-account'
              ? String(user.id)
              : await userIdForSubject(claims.sub)
        const decision = await hooks.beforeAccount({
          action: source.action,
          claims,
          existingUserId,
        })
        if (!decision.allow) {
          scope.refused = { code: decision.code, email: decision.email }
          return { error: decision.code }
        }
        if ('keepEmail' in decision) {
          scope.keepEmail = decision.keepEmail
          scope.emailKept = {
            kept: decision.keepEmail,
            attempted: claims.email,
          }
        }
      },
    },
    // Only Google changes a person's email, so changeEmail stays off.
    session: {
      expiresIn: THIRTY_DAYS,
      // Renew on use at most once an hour, so reading a page writes nothing.
      updateAge: 60 * 60,
      cookieCache: { enabled: false },
      additionalFields: {
        googleAccountId: { type: 'string', required: false, input: false },
      },
    },
    databaseHooks: {
      user: {
        update: {
          before: async (data) => {
            const keepEmail = scopes.getStore()?.keepEmail
            if (keepEmail === undefined || !('email' in data)) return
            return { data: { ...data, email: keepEmail } }
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const scope = scopes.getStore()
            if (scope?.claims === undefined) return
            const accountId = await accountIdForSubject(scope.claims.sub)
            if (accountId === null) return
            await hooks.afterSignIn({
              userId: session.userId,
              accountId,
              claims: scope.claims,
              newUser: scope.action === 'create-user',
              emailKept: scope.emailKept ?? null,
            })
            return { data: { ...session, googleAccountId: accountId } }
          },
        },
      },
    },
    onAPIError: { errorURL: `${origin}/_/sign-in` },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/social': { window: 60, max: 3 },
        '/get-session': false,
      },
    },
    advanced: {
      useSecureCookies: true,
      cookiePrefix: 'dossier',
      defaultCookieAttributes: {
        sameSite: 'lax',
        httpOnly: true,
        secure: true,
      },
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
    },
    telemetry: { enabled: false },
    plugins: [
      deviceAuthorization({
        expiresIn: '10m',
        interval: '5s',
        verificationUri: '/_/device',
        grant: deviceGrant,
      }),
      deviceRedemption,
      ...extraPlugins,
      tanstackStartCookies(),
    ],
  } satisfies BetterAuthOptions
}

/** Better Auth with Google and the device plugin, on D1 through Drizzle. */
export const makeAuthPort = (
  bindings: Env,
  config: DeploymentConfig,
  hooks: AuthHooks,
  extraPlugins: readonly BetterAuthPlugin[] = [],
): AuthPort => {
  const database = db(bindings)
  const auth = betterAuth(authOptions(database, config, hooks, extraPlugins))
  const api = auth.api as unknown as AuthApi

  /** A pending, unexpired code bound to this person. */
  const pendingFor = (code: string, userId: string, now: Date) =>
    and(
      eq(schema.deviceCode.userCode, code),
      eq(schema.deviceCode.userId, userId),
      eq(schema.deviceCode.status, 'pending'),
      gt(schema.deviceCode.expiresAt, now),
    )

  /** Approves or denies a code in one guarded statement. */
  const decide = (
    userCode: string,
    userId: string,
    change:
      | { status: 'approved'; approvedByGoogleAccountId: string | null }
      | { status: 'denied' },
  ) =>
    attempt(() =>
      database
        .update(schema.deviceCode)
        .set(change)
        .where(pendingFor(normalizeUserCode(userCode), userId, new Date()))
        .run(),
    ).pipe(
      Effect.flatMap((result) =>
        result.meta.changes === 1 ? Effect.void : Effect.fail(expired()),
      ),
    )

  return {
    handle: (request) => {
      const scope: SignInScope = {}
      return scopes.run(scope, async () => ({
        response: await auth.handler(request),
        outcome: {
          refused: scope.refused ?? null,
          emailKept: scope.emailKept ?? null,
        },
      }))
    },

    getSession: (headers) =>
      attempt(() =>
        scopes.run({}, () => api.getSession({ headers, returnHeaders: true })),
      ).pipe(
        Effect.map(({ headers: returned, response }) =>
          response === null
            ? null
            : {
                sessionId: response.session.id as SessionId,
                person: {
                  id: response.user.id as PersonId,
                  email: response.user.email,
                  name: response.user.name,
                  image: response.user.image ?? null,
                },
                googleAccountId: response.session.googleAccountId ?? null,
                setCookie: returned.getSetCookie(),
              },
        ),
      ),

    revokeUserSessions: (userId) =>
      attempt(async () => {
        const context = await auth.$context
        await context.internalAdapter.deleteUserSessions(userId)
      }),

    viewDevice: (userCode, userId) =>
      Effect.gen(function* () {
        const code = normalizeUserCode(userCode)
        const now = new Date()
        yield* attempt(() =>
          database
            .update(schema.deviceCode)
            .set({ userId })
            .where(
              and(
                eq(schema.deviceCode.userCode, code),
                eq(schema.deviceCode.status, 'pending'),
                isNull(schema.deviceCode.userId),
                gt(schema.deviceCode.expiresAt, now),
              ),
            )
            .run(),
        )
        const row = yield* attempt(() =>
          database
            .select({
              deviceName: schema.deviceCode.deviceName,
              expiresAt: schema.deviceCode.expiresAt,
            })
            .from(schema.deviceCode)
            .where(pendingFor(code, userId, now))
            .get(),
        )
        if (row === undefined) return yield* Effect.fail(expired())
        return {
          name: row.deviceName ?? 'device',
          expiresAt: row.expiresAt.getTime(),
        }
      }),

    approveDevice: (userCode, userId, googleAccountId) =>
      decide(userCode, userId, {
        status: 'approved',
        approvedByGoogleAccountId: googleAccountId,
      }),

    denyDevice: (userCode, userId) =>
      decide(userCode, userId, { status: 'denied' }),

    redeemDeviceCode: (deviceCode) =>
      attempt(() =>
        scopes.run({}, () =>
          api.redeemDossierDeviceCode({ body: { deviceCode } }),
        ),
      ),
  }
}

/** User codes are shown as WDJB-MJHT and stored as WDJBMJHT. */
const normalizeUserCode = (userCode: string): string =>
  userCode.replaceAll('-', '').trim().toUpperCase()

/** Better Auth against Google's real endpoints. */
export const AuthLive: Layer.Layer<Auth, never, Bindings | Config> =
  Layer.effect(
    Auth,
    Effect.gen(function* () {
      const bindings = yield* Bindings
      const config = yield* Config
      return (hooks: AuthHooks) => makeAuthPort(bindings, config, hooks)
    }),
  )
