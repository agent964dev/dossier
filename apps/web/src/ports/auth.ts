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
import { microsoft } from 'better-auth/social-providers'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { Context, Effect, Layer, Redacted } from 'effect'
import * as z from 'zod'

import { Bindings } from '../core/bindings.ts'
import {
  Config,
  type DeploymentConfig,
  type ProviderClient,
} from '../core/config.ts'
import {
  checkToken,
  emailOf,
  googleTrust,
  microsoftAccountKind,
  microsoftTrust,
  signInDiagnostic,
  type EmailTrust,
  type SignInDiagnostic,
  type TokenCheck,
} from '../core/sign-in-rules.ts'
import { db, schema } from '../db/client.ts'

/** A sign-in provider Dossier can turn on. */
export type SignInProviderId = 'google' | 'microsoft'

/** What Dossier reads from a provider at sign-in. */
export interface SignInClaims {
  readonly provider: SignInProviderId
  /** Google `sub`, Microsoft `oid`; Better Auth's `account.account_id`. */
  readonly subject: string
  /** Lower-cased; empty when the provider sent none. */
  readonly email: string
  /** The provider says this account controls `email` now. */
  readonly confirmed: boolean
  /** The provider is the email authority for `email` now. */
  readonly authority: boolean
  readonly name: string
  /** Google's photo URL or Microsoft's Graph data URL. */
  readonly picture?: string
  /** Google `hd`, or Microsoft `tid`; absent for a personal Google account. */
  readonly organisation?: string
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : ''

/** What each provider says about the email it sent. */
const trustOf: Record<
  SignInProviderId,
  (profile: Readonly<Record<string, unknown>>) => EmailTrust
> = {
  google: googleTrust,
  microsoft: microsoftTrust,
}

/** One reader per provider: the decoded ID token (plus Microsoft's photo) as SignInClaims. */
export const readClaims = (
  provider: SignInProviderId,
  profile: Readonly<Record<string, unknown>>,
): SignInClaims => {
  const email = emailOf(profile)
  const name = text(profile.name)
  const picture = text(profile.picture)
  const organisation =
    provider === 'google' ? text(profile.hd).toLowerCase() : text(profile.tid)
  return {
    provider,
    subject: text(provider === 'google' ? profile.sub : profile.oid),
    email,
    ...trustOf[provider](profile),
    name: name === '' ? email : name,
    ...(picture === '' ? {} : { picture }),
    ...(organisation === '' ? {} : { organisation }),
  }
}

/** What Better Auth is about to do with a sign-in. */
export type SignInAction = 'create-user' | 'link-account' | 'sign-in'

/** Why a sign-in was refused: a join the provider has no authority for, an unconfirmed email, no email. */
export type SignInRefusal = 'email_unconfirmed' | 'not_confirmed' | 'no_email'

/** A known account's new email that did not become the person's email. */
export interface EmailKept {
  readonly kept: string
  readonly attempted: string
  readonly because: 'in_use' | 'unconfirmed'
}

export type AccountDecision =
  | { readonly allow: true }
  /** Sign in, but keep the person's stored email rather than the provider's new one. */
  | {
      readonly allow: true
      readonly keepEmail: string
      readonly because: EmailKept['because']
    }
  | {
      readonly allow: false
      readonly code: 'email_unconfirmed' | 'not_confirmed'
      readonly email: string
    }

/** Dossier's rules, run inside Better Auth's sign-in. */
export interface AuthHooks {
  /** Runs before Better Auth creates a person, links an account or signs in. */
  readonly beforeAccount: (i: {
    readonly action: SignInAction
    readonly claims: SignInClaims
    readonly existingUserId: string | null
  }) => Promise<AccountDecision>
  /** Runs after a sign-in, before its session is written. */
  readonly afterSignIn: (i: {
    readonly userId: string
    readonly accountId: string
    readonly claims: SignInClaims
    readonly newUser: boolean
    readonly emailKept: EmailKept | null
  }) => Promise<void>
}

/** What a sign-in request did besides answering, for the redirect Dossier shows. */
export interface SignInOutcome {
  readonly refused: {
    readonly code: SignInRefusal
    readonly provider: SignInProviderId
    /** Empty for `no_email`. */
    readonly email: string
  } | null
  readonly emailKept:
    | (EmailKept & { readonly provider: SignInProviderId })
    | null
  /** The line to log for a refused or failed sign-in, when one is due. */
  readonly diagnostic: SignInDiagnostic | null
}

export interface SessionLookup {
  readonly sessionId: SessionId
  readonly person: Person
  /** The sign-in account that opened the session. */
  readonly signInAccountId: string | null
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
      readonly approvedByAccountId: string | null
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
  /** `signInAccountId`: the approving session's account, stored on the code. */
  readonly approveDevice: (
    userCode: string,
    userId: PersonId,
    signInAccountId: string | null,
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

/** What one sign-in request learned on its way through Better Auth. */
interface SignInScope {
  /** The profile the provider sent, and what Dossier read from it. */
  provider?: SignInProviderId
  profile?: Readonly<Record<string, unknown>>
  claims?: SignInClaims
  /** Why the provider's token failed its check, or null when it passed. */
  tokenCheck?: TokenCheck | null
  action?: SignInAction
  keepEmail?: string
  refused?: NonNullable<SignInOutcome['refused']>
  emailKept?: EmailKept
}

const scopes = new AsyncLocalStorage<SignInScope>()

const isProvider = (value: unknown): value is SignInProviderId =>
  value === 'google' || value === 'microsoft'

/**
 * Better Auth calls this with the decoded ID token. It reads the claims and
 * checks the token for the rest of the request, and tells Better Auth whether
 * the provider confirms the email, so Better Auth's own linking agrees.
 */
const mapProfileToUser =
  (provider: SignInProviderId, clientId: string) => (decoded: object) => {
    const profile = decoded as Readonly<Record<string, unknown>>
    const claims = readClaims(provider, profile)
    const scope = scopes.getStore()
    if (scope !== undefined) {
      scope.provider = provider
      scope.profile = profile
      scope.claims = claims
      scope.tokenCheck = checkToken(
        provider,
        profile,
        clientId,
        Math.floor(Date.now() / 1000),
      )
    }
    return { emailVerified: claims.confirmed }
  }

/** Whether a refusal of this kind writes a diagnostic line: every Microsoft one, and Google's token checks. */
const diagnosticDue = (
  provider: SignInProviderId,
  reason: SignInDiagnostic['reason'],
): boolean => provider === 'microsoft' || reason === 'token_check'

const CALLBACK = /^\/_\/auth\/callback\/([^/]+)$/

/**
 * What a request did, read from its scope and Better Auth's answer. Better
 * Auth refuses some sign-ins before Dossier's rules run, so its redirect error
 * is turned into Dossier's refusal when the scope says why.
 */
const outcomeOf = (
  request: Request,
  response: Response,
  scope: SignInScope,
): SignInOutcome => {
  const { provider, profile, claims } = scope
  const location = response.headers.get('location')
  const error =
    location === null
      ? null
      : new URL(location, request.url).searchParams.get('error')
  const diagnose = (
    on: SignInProviderId,
    reason: SignInDiagnostic['reason'],
    detail: { readonly check?: TokenCheck; readonly error?: string } = {},
  ) =>
    diagnosticDue(on, reason)
      ? signInDiagnostic(on, profile ?? null, reason, detail)
      : null
  const none = { refused: null, emailKept: null, diagnostic: null }

  if (provider === undefined || claims === undefined) {
    // The sign-in failed before any profile was read.
    const callback = CALLBACK.exec(new URL(request.url).pathname)?.[1]
    return error !== null && isProvider(callback)
      ? {
          ...none,
          diagnostic: diagnose(callback, 'provider_error', { error }),
        }
      : none
  }
  if (scope.tokenCheck != null) {
    // Whatever Better Auth refused, the token itself did not pass.
    return {
      ...none,
      diagnostic: diagnose(provider, 'token_check', {
        check: scope.tokenCheck,
      }),
    }
  }
  const refused =
    scope.refused ??
    (error === 'email_not_found'
      ? { code: 'no_email' as const, provider, email: '' }
      : error === 'account_not_linked' && !claims.confirmed
        ? { code: 'not_confirmed' as const, provider, email: claims.email }
        : null)
  if (refused !== null) {
    // A guest from another directory is never confirmed; its line says so.
    const guest =
      refused.code === 'not_confirmed' &&
      provider === 'microsoft' &&
      profile !== undefined &&
      microsoftAccountKind(profile) === 'guest'
    return {
      refused,
      emailKept: null,
      diagnostic:
        refused.code === 'email_unconfirmed'
          ? null
          : diagnose(provider, guest ? 'guest' : refused.code),
    }
  }
  return {
    ...none,
    emailKept:
      scope.emailKept === undefined ? null : { ...scope.emailKept, provider },
  }
}

const GRAPH_PHOTO = 'https://graph.microsoft.com/v1.0/me/photos/48x48/$value'

const base64Of = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** The 48×48 Graph photo as a data URL, or null on any failure (404, network, non-image). */
export const graphPhoto = async (
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> => {
  try {
    const response = await fetcher(GRAPH_PHOTO, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    const type = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      ?.trim()
      .toLowerCase()
    if (!response.ok || type === undefined || !type.startsWith('image/')) {
      return null
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.length === 0 ? null : `data:${type};base64,${base64Of(bytes)}`
  } catch {
    return null
  }
}

type MicrosoftTokens = Parameters<
  ReturnType<typeof microsoft>['getUserInfo']
>[0]

/**
 * Better Auth's Microsoft provider for `common`, with Dossier's rules. Its
 * own photo download would stop the sign-in on a network failure, so Dossier
 * fetches the photo first, best effort, and then runs a second built-in
 * provider (a `getUserInfo` option replaces the built-in one whole). The photo
 * goes on the profile the claims are read from, and on both outputs, because
 * Better Auth builds the person's image and the stored profile from its own
 * decoded token; no photo clears them.
 */
const microsoftProvider = (client: ProviderClient) => {
  const options = {
    clientId: client.clientId,
    clientSecret: Redacted.value(client.clientSecret),
    tenantId: 'common',
    prompt: 'select_account' as const,
    // The email, name and photo follow Microsoft at every sign-in.
    overrideUserInfoOnSignIn: true,
    disableProfilePhoto: true,
  }
  const toUser = mapProfileToUser('microsoft', client.clientId)
  return {
    ...options,
    mapProfileToUser: toUser,
    getUserInfo: async (token: MicrosoftTokens) => {
      const picture =
        token.accessToken === undefined || token.accessToken === ''
          ? null
          : await graphPhoto(token.accessToken)
      const result = await microsoft({
        ...options,
        mapProfileToUser: (profile) =>
          toUser({ ...profile, picture: picture ?? undefined }),
      }).getUserInfo(token)
      if (result === null) return null
      return {
        user: { ...result.user, image: picture ?? undefined },
        // Better Auth's type says every profile has a picture; with its own
        // download off, none has one unless Dossier's download found it.
        data: {
          ...result.data,
          picture: picture ?? undefined,
        } as typeof result.data,
      }
    },
  }
}

const deviceGrant = {
  requestSchemaFields: { device_name: z.string().trim().min(1).max(64) },
  deviceCodeSchemaFields: {
    deviceName: { type: 'string', required: false, input: false },
    grantKind: { type: 'string', required: false, input: false },
    approvedByAccountId: {
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
              approvedByAccountId?: string | null
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
            approvedByAccountId: claimedDeviceCode.approvedByAccountId ?? null,
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
      session: { id: string; signInAccountId?: string | null }
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
  const bySubject = (provider: SignInProviderId, subject: string) =>
    and(
      eq(schema.account.providerId, provider),
      eq(schema.account.accountId, subject),
    )

  async function accountIdForSubject(
    provider: SignInProviderId,
    subject: string,
  ): Promise<string | null> {
    const row = await database
      .select({ id: schema.account.id })
      .from(schema.account)
      .where(bySubject(provider, subject))
      .get()
    return row?.id ?? null
  }

  async function userIdForSubject(
    provider: SignInProviderId,
    subject: string,
  ): Promise<string | null> {
    const row = await database
      .select({ userId: schema.account.userId })
      .from(schema.account)
      .where(bySubject(provider, subject))
      .get()
    return row?.userId ?? null
  }

  return { accountIdForSubject, userIdForSubject }
}

/**
 * Better Auth's options: the sign-in providers turned on and the device
 * plugin, on D1 through Drizzle.
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
    // A person's name and photo come only from a provider, at sign-in.
    // Sign-in accounts join only by signing in, and leave only through
    // Dossier's disconnect, which ends what they opened.
    disabledPaths: [
      '/update-user',
      '/link-social',
      '/list-accounts',
      '/unlink-account',
    ],
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
    socialProviders: {
      ...(config.google === null
        ? {}
        : {
            google: {
              clientId: config.google.clientId,
              clientSecret: Redacted.value(config.google.clientSecret),
              prompt: 'select_account' as const,
              // The email follows Google at every sign-in.
              overrideUserInfoOnSignIn: true,
              mapProfileToUser: mapProfileToUser(
                'google',
                config.google.clientId,
              ),
            },
          }),
      ...(config.microsoft === null
        ? {}
        : { microsoft: microsoftProvider(config.microsoft) }),
    },
    account: {
      // Linking by email is on; Dossier's guard narrows it in
      // validateUserInfo. The provider's authority decides a join, not the
      // stored person's verified flag.
      accountLinking: {
        enabled: true,
        trustedProviders: [],
        requireLocalEmailVerified: false,
      },
    },
    user: {
      validateUserInfo: async ({ user, source }) => {
        const provider =
          source.method === 'oauth' ? source.oauth?.providerId : undefined
        if (!isProvider(provider)) return
        const scope = scopes.getStore()
        // A sign-in outside Dossier's scope, or whose profile Dossier did not
        // read, could not be recorded.
        if (scope?.claims === undefined || scope.provider !== provider) {
          return { error: 'unavailable' }
        }
        // A token that failed its check is refused before any rule.
        if (scope.tokenCheck != null) return { error: 'unavailable' }
        const { claims } = scope
        const { action } = source
        scope.action = action
        if (claims.email === '') {
          scope.refused = { code: 'no_email', provider, email: '' }
          return { error: 'no_email' }
        }
        // Creating a person or joining one needs a confirmed email.
        if (
          (action === 'create-user' || action === 'link-account') &&
          !claims.confirmed
        ) {
          scope.refused = {
            code: 'not_confirmed',
            provider,
            email: claims.email,
          }
          return { error: 'not_confirmed' }
        }
        const existingUserId =
          action === 'create-user'
            ? null
            : action === 'link-account'
              ? String(user.id)
              : await userIdForSubject(provider, claims.subject)
        const decision = await hooks.beforeAccount({
          action,
          claims,
          existingUserId,
        })
        if (!decision.allow) {
          scope.refused = {
            code: decision.code,
            provider,
            email: decision.email,
          }
          return { error: decision.code }
        }
        if ('keepEmail' in decision) {
          scope.keepEmail = decision.keepEmail
          scope.emailKept = {
            kept: decision.keepEmail,
            attempted: claims.email,
            because: decision.because,
          }
        }
      },
    },
    // Only a provider changes a person's email, so changeEmail stays off.
    session: {
      expiresIn: THIRTY_DAYS,
      // Renew on use at most once an hour, so reading a page writes nothing.
      updateAge: 60 * 60,
      cookieCache: { enabled: false },
      additionalFields: {
        signInAccountId: { type: 'string', required: false, input: false },
      },
    },
    databaseHooks: {
      user: {
        update: {
          before: async (data) => {
            const scope = scopes.getStore()
            // The profile the provider sent at this sign-in. Better Auth
            // leaves out a photo the provider no longer sends; the person has
            // none now.
            const profile =
              scope?.claims !== undefined && 'name' in data
                ? { image: scope.claims.picture ?? null }
                : {}
            // Keeping the stored email keeps its verified flag too. Better
            // Auth merges this result over its own update, and writes neither
            // field when both are undefined.
            const email =
              scope?.keepEmail !== undefined && 'email' in data
                ? { email: undefined, emailVerified: undefined }
                : {}
            return { data: { ...data, ...profile, ...email } }
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const scope = scopes.getStore()
            if (scope?.claims === undefined) return
            const accountId = await accountIdForSubject(
              scope.claims.provider,
              scope.claims.subject,
            )
            if (accountId === null) return
            await hooks.afterSignIn({
              userId: session.userId,
              accountId,
              claims: scope.claims,
              newUser: scope.action === 'create-user',
              emailKept: scope.emailKept ?? null,
            })
            return { data: { ...session, signInAccountId: accountId } }
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

/** Better Auth with the sign-in providers and the device plugin, on D1 through Drizzle. */
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
      | { status: 'approved'; approvedByAccountId: string | null }
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
      return scopes.run(scope, async () => {
        const response = await auth.handler(request)
        return { response, outcome: outcomeOf(request, response, scope) }
      })
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
                signInAccountId: response.session.signInAccountId ?? null,
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

    approveDevice: (userCode, userId, signInAccountId) =>
      decide(userCode, userId, {
        status: 'approved',
        approvedByAccountId: signInAccountId,
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

/** Better Auth against the providers' real endpoints. */
export const AuthLive: Layer.Layer<Auth, never, Bindings | Config> =
  Layer.effect(
    Auth,
    Effect.gen(function* () {
      const bindings = yield* Bindings
      const config = yield* Config
      return (hooks: AuthHooks) => makeAuthPort(bindings, config, hooks)
    }),
  )
