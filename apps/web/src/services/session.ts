import { Context, Effect, Layer } from 'effect'

import { WorkerEnv } from './env'
import { SessionError } from './errors'

export const SESSION_COOKIE = 'dossier_session'
export const AUTH_STATE_COOKIE = 'dossier_auth_state'
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
export const AUTH_STATE_TTL_SECONDS = 10 * 60

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const binary = atob(padded)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

export interface SessionPayload {
  readonly accountId: string
  readonly workspaceId: string
  readonly accountName?: string
  readonly email?: string | null
  readonly pictureUrl?: string | null
  readonly exp?: number
}

export interface SessionService {
  readonly production: boolean
  readonly cookieName: (kind: 'session' | 'auth-state') => string
  readonly signToken: <A extends Record<string, unknown>>(
    payload: A,
    ttlSeconds: number,
    nowSeconds?: number,
  ) => Effect.Effect<string, SessionError>
  readonly verifyToken: (
    token: string,
    nowSeconds?: number,
  ) => Effect.Effect<Record<string, unknown> | null>
  readonly createSessionCookie: (
    payload: SessionPayload,
  ) => Effect.Effect<string, SessionError>
  readonly createAuthStateCookie: (
    payload: Record<string, unknown>,
  ) => Effect.Effect<string, SessionError>
  readonly clearSessionCookie: () => string
  readonly clearAuthStateCookie: () => string
  readonly readSession: (
    request: Request,
  ) => Effect.Effect<SessionPayload | null>
  readonly readAuthState: (
    request: Request,
  ) => Effect.Effect<Record<string, unknown> | null>
}

export class Session extends Context.Tag('@dossier/web/Session')<
  Session,
  SessionService
>() {}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const equals = part.indexOf('=')
    if (equals < 0 || part.slice(0, equals).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(equals + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

function serializeCookie(
  name: string,
  value: string,
  maxAge: number,
  production: boolean,
): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ]
  if (production) attributes.push('Secure')
  return attributes.join('; ')
}

export function makeSession(
  secret: string,
  production: boolean,
): SessionService {
  const name = (plain: string) => (production ? `__Host-${plain}` : plain)
  const importKey = () =>
    crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    )

  const signToken: SessionService['signToken'] = (payload, ttl, now) =>
    Effect.tryPromise({
      try: async () => {
        const body = base64Url(
          encoder.encode(
            JSON.stringify({
              ...payload,
              exp: (now ?? Math.floor(Date.now() / 1000)) + ttl,
            }),
          ),
        )
        const signature = await crypto.subtle.sign(
          'HMAC',
          await importKey(),
          encoder.encode(body),
        )
        return `${body}.${base64Url(new Uint8Array(signature))}`
      },
      catch: (cause) =>
        new SessionError({ message: 'Could not sign session token.', cause }),
    })

  const verifyToken: SessionService['verifyToken'] = (token, now) =>
    Effect.promise(async () => {
      try {
        if (typeof token !== 'string') return null
        const pieces = token.split('.')
        if (pieces.length !== 2) return null
        const [body, signatureText] = pieces
        const signature = decodeBase64Url(signatureText)
        const encodedBody = decodeBase64Url(body)
        if (!signature || !encodedBody) return null
        const valid = await crypto.subtle.verify(
          'HMAC',
          await importKey(),
          Uint8Array.from(signature).buffer,
          encoder.encode(body),
        )
        if (!valid) return null
        const payload = JSON.parse(decoder.decode(encodedBody)) as Record<
          string,
          unknown
        >
        const exp = payload.exp
        if (
          typeof exp !== 'number' ||
          !Number.isFinite(exp) ||
          exp < (now ?? Math.floor(Date.now() / 1000))
        ) {
          return null
        }
        return payload
      } catch {
        return null
      }
    })

  const cookieName: SessionService['cookieName'] = (kind) =>
    name(kind === 'session' ? SESSION_COOKIE : AUTH_STATE_COOKIE)

  return {
    production,
    cookieName,
    signToken,
    verifyToken,
    createSessionCookie: (payload) =>
      Effect.map(
        signToken({ ...payload, purpose: 'session' }, SESSION_TTL_SECONDS),
        (token) =>
          serializeCookie(
            cookieName('session'),
            token,
            SESSION_TTL_SECONDS,
            production,
          ),
      ),
    createAuthStateCookie: (payload) =>
      Effect.map(
        signToken(
          { ...payload, purpose: 'auth-state' },
          AUTH_STATE_TTL_SECONDS,
        ),
        (token) =>
          serializeCookie(
            cookieName('auth-state'),
            token,
            AUTH_STATE_TTL_SECONDS,
            production,
          ),
      ),
    clearSessionCookie: () =>
      serializeCookie(cookieName('session'), '', 0, production),
    clearAuthStateCookie: () =>
      serializeCookie(cookieName('auth-state'), '', 0, production),
    readSession: (request) => {
      const token = readCookie(request, cookieName('session'))
      if (!token) return Effect.succeed(null)
      return Effect.map(verifyToken(token), (payload) => {
        if (
          payload === null ||
          payload.purpose !== 'session' ||
          typeof payload.accountId !== 'string' ||
          payload.accountId.length === 0 ||
          typeof payload.workspaceId !== 'string' ||
          payload.workspaceId.length === 0 ||
          (payload.accountName !== undefined &&
            typeof payload.accountName !== 'string') ||
          (payload.email !== undefined &&
            payload.email !== null &&
            typeof payload.email !== 'string') ||
          (payload.pictureUrl !== undefined &&
            payload.pictureUrl !== null &&
            typeof payload.pictureUrl !== 'string')
        ) {
          return null
        }
        return payload as unknown as SessionPayload
      })
    },
    readAuthState: (request) => {
      const token = readCookie(request, cookieName('auth-state'))
      if (!token) return Effect.succeed(null)
      return Effect.map(verifyToken(token), (payload) =>
        payload?.purpose === 'auth-state' ? payload : null,
      )
    },
  }
}

export const SessionLive = Layer.effect(
  Session,
  Effect.map(WorkerEnv, (env) => {
    if (!env.SESSION_SECRET)
      throw new Error('SESSION_SECRET is not configured.')
    const url = new URL(env.PUBLIC_BASE_URL)
    const production =
      url.protocol === 'https:' &&
      !['localhost', '127.0.0.1'].includes(url.hostname)
    return makeSession(env.SESSION_SECRET, production)
  }),
)

export const SessionLayer = (secret: string, production = false) =>
  Layer.succeed(Session, makeSession(secret, production))
