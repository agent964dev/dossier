import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import { Context, Effect, Layer } from 'effect'

import { WorkerEnv } from './env'
import { ShooError } from './errors'
import { Ids } from './ids'

export interface PkceState {
  readonly verifier: string
  readonly challenge: string
  readonly state: string
}

export interface ShooClaims extends JWTPayload {
  readonly pairwise_sub: string
  readonly email?: string
  readonly email_verified?: boolean
  readonly name?: string
  readonly picture?: string
  readonly pii_sub?: string
}

export interface ShooService {
  readonly buildPkce: () => Effect.Effect<PkceState>
  readonly buildAuthorizeUrl: (options: {
    readonly redirectUri: string
    readonly state: string
    readonly challenge: string
  }) => string
  readonly exchangeCode: (options: {
    readonly code: string
    readonly verifier: string
    readonly redirectUri: string
  }) => Effect.Effect<{ readonly idToken: string }, ShooError>
  readonly verifyIdToken: (
    idToken: string,
  ) => Effect.Effect<ShooClaims, ShooError>
}

export class Shoo extends Context.Tag('@dossier/web/Shoo')<Shoo, ShooService>() {}

const issuers = new Map<string, Promise<string>>()
const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export function resetShooCaches(): void {
  issuers.clear()
  jwks.clear()
}

export const ShooLive = Layer.effect(
  Shoo,
  Effect.gen(function* () {
    const env = yield* WorkerEnv
    const ids = yield* Ids
    const baseUrl = env.SHOO_BASE_URL.replace(/\/$/, '')
    const audience = `origin:${new URL(env.PUBLIC_BASE_URL).origin}`

    const getIssuer = (): Promise<string> => {
      const cached = issuers.get(baseUrl)
      if (cached) return cached
      const pending = fetch(`${baseUrl}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(10_000),
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Shoo discovery failed: ${response.status}`)
          const body = (await response.json()) as { issuer?: unknown }
          if (typeof body.issuer !== 'string') {
            throw new Error('Shoo discovery document has no issuer.')
          }
          return body.issuer
        })
        .catch((cause) => {
          issuers.delete(baseUrl)
          throw cause
        })
      issuers.set(baseUrl, pending)
      return pending
    }

    const getJwks = () => {
      const cached = jwks.get(baseUrl)
      if (cached) return cached
      const created = createRemoteJWKSet(
        new URL(`${baseUrl}/.well-known/jwks.json`),
      )
      jwks.set(baseUrl, created)
      return created
    }

    return {
      buildPkce: () =>
        Effect.gen(function* () {
          const verifier = ids.randomToken(32)
          return {
            verifier,
            challenge: yield* ids.sha256Base64Url(verifier),
            state: ids.randomToken(24),
          }
        }),
      buildAuthorizeUrl: ({ redirectUri, state, challenge }) => {
        const url = new URL(`${baseUrl}/authorize`)
        url.searchParams.set('redirect_uri', redirectUri)
        url.searchParams.set('state', state)
        url.searchParams.set('code_challenge', challenge)
        url.searchParams.set('code_challenge_method', 'S256')
        url.searchParams.set('pii', 'true')
        return url.toString()
      },
      exchangeCode: ({ code, verifier, redirectUri }) =>
        Effect.tryPromise({
          try: async () => {
            const response = await fetch(`${baseUrl}/token`, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                grant_type: 'authorization_code',
                redirect_uri: redirectUri,
                code,
                code_verifier: verifier,
              }),
              signal: AbortSignal.timeout(10_000),
            })
            const body = (await response.json().catch(() => ({}))) as {
              id_token?: unknown
              error?: unknown
            }
            if (!response.ok) {
              throw new Error(
                `Shoo token exchange failed: ${String(body.error ?? response.status)}`,
              )
            }
            if (typeof body.id_token !== 'string') {
              throw new Error('Shoo token exchange returned no id_token.')
            }
            return { idToken: body.id_token }
          },
          catch: (cause) =>
            new ShooError({ message: 'Shoo token exchange failed.', cause }),
        }),
      verifyIdToken: (idToken) =>
        Effect.tryPromise({
          try: async () => {
            const { payload } = await jwtVerify(idToken, getJwks(), {
              issuer: await getIssuer(),
              audience,
              algorithms: ['ES256'],
            })
            if (
              typeof payload.pairwise_sub !== 'string' ||
              payload.pairwise_sub.length === 0
            ) {
              throw new Error('Shoo id_token is missing pairwise_sub.')
            }
            return payload as ShooClaims
          },
          catch: (cause) =>
            new ShooError({ message: 'Shoo id_token verification failed.', cause }),
        }),
    }
  }),
)
