// A stand-in for Microsoft inside the test Worker: login.microsoftonline.com
// for consent and tokens, graph.microsoft.com for the photo. It replaces
// fetch for Microsoft's hosts, plays the consent step for the `common`
// tenant, and serves a token endpoint that returns real RS256 ID tokens with
// the claims each test chooses. The chosen identity travels inside the code,
// and the photo inside the access token Graph is called with.

/** The tenant every personal Microsoft account's token carries. */
export const PERSONAL_TID = '9188040d-6c67-4c5b-b112-36a304b66dad'

const LOGIN = 'https://login.microsoftonline.com'
export const MICROSOFT_AUTHORIZE = `${LOGIN}/common/oauth2/v2.0/authorize`
const MICROSOFT_TOKEN = `${LOGIN}/common/oauth2/v2.0/token`
const MICROSOFT_JWKS = `${LOGIN}/common/discovery/v2.0/keys`
const GRAPH = 'https://graph.microsoft.com'
export const GRAPH_PHOTO = `${GRAPH}/v1.0/me/photos/48x48/$value`
const GRAPH_USERINFO = `${GRAPH}/oidc/userinfo`
const KID = 'fake-microsoft'

export interface FakeMicrosoftIdentity {
  readonly oid: string
  /** PERSONAL_TID for a personal account. */
  readonly tid: string
  /** Absent: Microsoft sent none. */
  readonly email?: string
  readonly xms_edov?: boolean
  readonly idp?: string
  readonly name?: string
  /**
   * Bytes served as the photo; null or absent serves 404, as Graph does for
   * an account without one; 'network-error' makes the fetch throw.
   */
  readonly photo?: Uint8Array | null | 'network-error'
  /**
   * Claims a test sets or overrides in the ID token (iss, aud, exp,
   * email_verified, …). A claim set to undefined is left out, so
   * `{ oid: undefined }` issues a token without `oid`.
   */
  readonly token?: Readonly<Record<string, unknown>>
}

export interface FakeMicrosoft {
  readonly clientId: string
  /**
   * The secret the token endpoint accepts. Any other answers 401
   * `invalid_client`, as Microsoft does for an expired secret.
   */
  readonly clientSecret: string
  /** Every request Dossier sent to Microsoft, as `METHOD origin/path`. */
  readonly log: string[]
}

type Photo = { readonly bytes: string } | null | 'network-error'

interface CodePayload {
  readonly identity: Omit<FakeMicrosoftIdentity, 'photo'> & {
    readonly photo: Photo
    /** The `token` claims set to undefined, which JSON would drop. */
    readonly omit: readonly string[]
  }
  readonly client_id: string
  readonly redirect_uri: string
  readonly code_challenge: string
  readonly scope: string
}

const encoder = new TextEncoder()

const base64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
const base64url = (bytes: Uint8Array): string =>
  base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const bytesOf = (text: string): Uint8Array =>
  Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  )
const encodeJson = (value: unknown) =>
  base64url(encoder.encode(JSON.stringify(value)))
const decodeJson = (value: string): unknown =>
  JSON.parse(new TextDecoder().decode(bytesOf(value)))

let keys: Promise<{ privateKey: CryptoKey; jwk: JsonWebKey }> | undefined
const signingKey = () => {
  keys ??= (async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    const jwk = (await crypto.subtle.exportKey(
      'jwk',
      pair.publicKey,
    )) as JsonWebKey
    return {
      privateKey: pair.privateKey,
      jwk: { ...jwk, alg: 'RS256', use: 'sig', kid: KID } as JsonWebKey,
    }
  })()
  return keys
}

const s256 = async (verifier: string) =>
  base64url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(verifier)),
    ),
  )

/** The ID token's claims for `identity`, as Microsoft's v2.0 endpoint sends them. */
export const microsoftClaims = (
  identity: Omit<FakeMicrosoftIdentity, 'photo'>,
  audience: string,
  now = Math.floor(Date.now() / 1000),
): Record<string, unknown> => {
  const name =
    identity.name ?? identity.email?.split('@')[0] ?? 'Someone at Microsoft'
  const claims: Record<string, unknown> = {
    ver: '2.0',
    iss: `${LOGIN}/${identity.tid}/v2.0`,
    aud: audience,
    iat: now,
    nbf: now,
    exp: now + 3600,
    tid: identity.tid,
    oid: identity.oid,
    // Microsoft's sub is pairwise per app, never the oid.
    sub: `pairwise-${identity.oid}`,
    name,
    // A work account's sign-in name, which is not its email.
    preferred_username:
      identity.email ?? `upn-${identity.oid}@tenant.onmicrosoft.com`,
    ...(identity.email === undefined ? {} : { email: identity.email }),
    ...(identity.xms_edov === undefined ? {} : { xms_edov: identity.xms_edov }),
    ...(identity.idp === undefined ? {} : { idp: identity.idp }),
    ...identity.token,
  }
  for (const [claim, value] of Object.entries(claims)) {
    if (value === undefined) delete claims[claim]
  }
  return claims
}

const signIdToken = async (claims: Record<string, unknown>) => {
  const input = `${encodeJson({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${encodeJson(claims)}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    (await signingKey()).privateKey,
    encoder.encode(input),
  )
  return `${input}.${base64url(new Uint8Array(signature))}`
}

const authorizeParams = (authorizeUrl: string) => {
  const url = new URL(authorizeUrl)
  if (`${url.origin}${url.pathname}` !== MICROSOFT_AUTHORIZE) {
    throw new Error(`not Microsoft's common authorization URL: ${authorizeUrl}`)
  }
  return url.searchParams
}

/** The consent screen: given Dossier's authorization URL, the callback URL. */
export const consentMicrosoft = (
  authorizeUrl: string,
  identity: FakeMicrosoftIdentity,
): URL => {
  const params = authorizeParams(authorizeUrl)
  if (params.get('response_type') !== 'code')
    throw new Error('response_type must be code')
  if (params.get('code_challenge_method') !== 'S256')
    throw new Error('PKCE S256 is required')
  const scope = params.get('scope') ?? ''
  if (!scope.split(' ').includes('openid')) {
    throw new Error('the openid scope is missing')
  }
  const { photo, ...rest } = identity
  const payload: CodePayload = {
    identity: {
      ...rest,
      omit: Object.entries(identity.token ?? {})
        .filter(([, value]) => value === undefined)
        .map(([claim]) => claim),
      photo:
        photo === undefined || photo === null
          ? null
          : photo === 'network-error'
            ? photo
            : { bytes: base64(photo) },
    },
    client_id: params.get('client_id') ?? '',
    redirect_uri: params.get('redirect_uri') ?? '',
    code_challenge: params.get('code_challenge') ?? '',
    scope,
  }
  const callback = new URL(payload.redirect_uri)
  callback.searchParams.set(
    'code',
    `fakems.${encodeJson(payload)}.${crypto.randomUUID()}`,
  )
  callback.searchParams.set('state', params.get('state') ?? '')
  return callback
}

/**
 * The person refuses consent (or their organisation blocks it): Microsoft
 * returns to the callback with `error=access_denied` and no code.
 */
export const refuseMicrosoftConsent = (authorizeUrl: string): URL => {
  const params = authorizeParams(authorizeUrl)
  const callback = new URL(params.get('redirect_uri') ?? '')
  callback.searchParams.set('error', 'access_denied')
  callback.searchParams.set(
    'error_description',
    'AADSTS65004: User declined to consent to access the app.',
  )
  callback.searchParams.set('state', params.get('state') ?? '')
  return callback
}

const usedCodes = new Set<string>()

const tokenEndpoint = async (request: Request, microsoft: FakeMicrosoft) => {
  const form = new URLSearchParams(
    new TextDecoder().decode(await request.arrayBuffer()),
  )
  let clientId = form.get('client_id')
  let clientSecret = form.get('client_secret')
  const basic = request.headers.get('authorization')
  if (basic?.startsWith('Basic ')) {
    const [id = '', secret = ''] = atob(basic.slice(6)).split(':')
    clientId = decodeURIComponent(id)
    clientSecret = decodeURIComponent(secret)
  }
  const refuse = (description: string) =>
    Response.json(
      { error: 'invalid_grant', error_description: description },
      { status: 400 },
    )
  if (form.get('grant_type') !== 'authorization_code')
    return refuse('grant_type')
  if (
    clientId !== microsoft.clientId ||
    clientSecret !== microsoft.clientSecret
  ) {
    return Response.json(
      {
        error: 'invalid_client',
        error_description:
          'AADSTS7000222: The provided client secret keys for app are expired.',
      },
      { status: 401 },
    )
  }
  const code = form.get('code') ?? ''
  if (!code.startsWith('fakems.') || usedCodes.has(code))
    return refuse('code unknown or reused')
  usedCodes.add(code)
  const payload = decodeJson(code.split('.')[1] ?? '') as CodePayload
  if (payload.client_id !== clientId) return refuse('client mismatch')
  if (payload.redirect_uri !== form.get('redirect_uri'))
    return refuse('redirect_uri mismatch')
  if (
    payload.code_challenge !== (await s256(form.get('code_verifier') ?? ''))
  ) {
    return refuse('PKCE verifier mismatch')
  }
  const { photo, omit, ...identity } = payload.identity
  const claims = microsoftClaims(identity, microsoft.clientId)
  for (const claim of omit) delete claims[claim]
  const grant = {
    photo,
    sub: claims.sub,
    name: claims.name,
    email: claims.email,
  }
  return Response.json({
    token_type: 'Bearer',
    scope: payload.scope
      .split(' ')
      .filter((s) => s !== 'offline_access')
      .join(' '),
    expires_in: 3599,
    ext_expires_in: 3599,
    access_token: `fakems-at.${encodeJson(grant)}.${crypto.randomUUID()}`,
    refresh_token: `fakems-rt.${crypto.randomUUID()}`,
    id_token: await signIdToken(claims),
  })
}

const grantOf = (request: Request) => {
  const auth = request.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token.startsWith('fakems-at.')) return null
  return decodeJson(token.split('.')[1] ?? '') as {
    readonly photo: Photo
    readonly sub?: string
    readonly name?: string
    readonly email?: string
  }
}

const photoEndpoint = (request: Request) => {
  const grant = grantOf(request)
  if (grant === null) {
    return Response.json(
      { error: { code: 'InvalidAuthenticationToken' } },
      { status: 401 },
    )
  }
  if (grant.photo === 'network-error') {
    throw new TypeError('Network connection lost.')
  }
  if (grant.photo === null) {
    return Response.json(
      { error: { code: 'ImageNotFound', message: 'Exception of type …' } },
      { status: 404 },
    )
  }
  const bytes = bytesOf(grant.photo.bytes)
  const png = bytes[0] === 0x89 && bytes[1] === 0x50
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: { 'content-type': png ? 'image/png' : 'image/jpeg' },
  })
}

const userinfoEndpoint = (request: Request) => {
  const grant = grantOf(request)
  if (grant === null) return new Response(null, { status: 401 })
  return Response.json({
    sub: grant.sub,
    name: grant.name,
    ...(grant.email === undefined ? {} : { email: grant.email }),
  })
}

const isMicrosoft = (url: URL) =>
  url.hostname === 'login.microsoftonline.com' ||
  url.hostname === 'graph.microsoft.com'

let installed: FakeMicrosoft | undefined

/** Installs the fake into this isolate's fetch, once. */
export const installFakeMicrosoft = (client: {
  clientId: string
  clientSecret: string
}): FakeMicrosoft => {
  if (installed !== undefined) return installed
  const microsoft: FakeMicrosoft = { ...client, log: [] }
  installed = microsoft
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (!isMicrosoft(url)) return realFetch(input, init)
    const target = `${url.origin}${decodeURIComponent(url.pathname)}`
    microsoft.log.push(`${request.method} ${target}`)
    if (target === MICROSOFT_TOKEN && request.method === 'POST')
      return tokenEndpoint(request, microsoft)
    if (target === MICROSOFT_JWKS)
      return Response.json({ keys: [(await signingKey()).jwk] })
    if (target === GRAPH_PHOTO && request.method === 'GET')
      return photoEndpoint(request)
    if (target === GRAPH_USERINFO) return userinfoEndpoint(request)
    return new Response('fake Microsoft: unexpected request', { status: 599 })
  }) as typeof fetch
  return microsoft
}
