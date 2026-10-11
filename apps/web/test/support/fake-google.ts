// A stand-in for Google inside the test Worker. It replaces fetch for
// Google's hosts, plays the consent step, and serves a token endpoint that
// returns real RS256 ID tokens with the claims each test chooses, and the
// JWKS that verifies them. The chosen identity travels inside the code.

export const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs'
const KID = 'fake-google'

export interface FakeIdentity {
  readonly sub: string
  readonly email: string
  readonly email_verified?: boolean
  readonly hd?: string
  readonly name?: string
}

export interface FakeGoogle {
  readonly clientId: string
  readonly clientSecret: string
  /** Every request Dossier sent to Google, for assertions. */
  readonly log: string[]
}

interface CodePayload {
  readonly identity: FakeIdentity
  readonly client_id: string
  readonly redirect_uri: string
  readonly code_challenge: string
  readonly nonce?: string
}

const encoder = new TextEncoder()

const base64url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}
const encodeJson = (value: unknown) =>
  base64url(encoder.encode(JSON.stringify(value)))
const decodeJson = (value: string): unknown =>
  JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(
        atob(value.replaceAll('-', '+').replaceAll('_', '/')),
        (c) => c.charCodeAt(0),
      ),
    ),
  )

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

const signIdToken = async (
  identity: FakeIdentity,
  audience: string,
  nonce?: string,
) => {
  const now = Math.floor(Date.now() / 1000)
  const name = identity.name ?? identity.email.split('@')[0] ?? 'someone'
  const claims: Record<string, unknown> = {
    iss: 'https://accounts.google.com',
    aud: audience,
    azp: audience,
    sub: identity.sub,
    email: identity.email,
    email_verified: identity.email_verified ?? true,
    name,
    given_name: name,
    picture: `https://lh3.googleusercontent.com/a/${identity.sub}`,
    iat: now,
    exp: now + 3600,
    ...(identity.hd === undefined ? {} : { hd: identity.hd }),
    ...(nonce === undefined ? {} : { nonce }),
  }
  const input = `${encodeJson({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${encodeJson(claims)}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    (await signingKey()).privateKey,
    encoder.encode(input),
  )
  return `${input}.${base64url(new Uint8Array(signature))}`
}

/** The consent screen: given Dossier's authorization URL, the callback URL. */
export const consent = (authorizeUrl: string, identity: FakeIdentity): URL => {
  const url = new URL(authorizeUrl)
  if (`${url.origin}${url.pathname}` !== GOOGLE_AUTHORIZE) {
    throw new Error(`not Google's authorization URL: ${authorizeUrl}`)
  }
  const params = url.searchParams
  if (params.get('response_type') !== 'code')
    throw new Error('response_type must be code')
  if (params.get('code_challenge_method') !== 'S256')
    throw new Error('PKCE S256 is required')
  if (!(params.get('scope') ?? '').split(' ').includes('openid')) {
    throw new Error('the openid scope is missing')
  }
  const payload: CodePayload = {
    identity,
    client_id: params.get('client_id') ?? '',
    redirect_uri: params.get('redirect_uri') ?? '',
    code_challenge: params.get('code_challenge') ?? '',
    ...(params.get('nonce') === null
      ? {}
      : { nonce: params.get('nonce') ?? '' }),
  }
  const callback = new URL(payload.redirect_uri)
  callback.searchParams.set(
    'code',
    `fake.${encodeJson(payload)}.${crypto.randomUUID()}`,
  )
  callback.searchParams.set('state', params.get('state') ?? '')
  return callback
}

const usedCodes = new Set<string>()

const tokenEndpoint = async (request: Request, google: FakeGoogle) => {
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
  if (clientId !== google.clientId || clientSecret !== google.clientSecret) {
    return Response.json({ error: 'invalid_client' }, { status: 401 })
  }
  const code = form.get('code') ?? ''
  if (!code.startsWith('fake.') || usedCodes.has(code))
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
  return Response.json({
    access_token: `ya29.fake-${crypto.randomUUID()}`,
    expires_in: 3599,
    scope: 'openid email profile',
    token_type: 'Bearer',
    id_token: await signIdToken(
      payload.identity,
      google.clientId,
      payload.nonce,
    ),
  })
}

let installed: FakeGoogle | undefined

/** Installs the fake into this isolate's fetch, once. */
export const installFakeGoogle = (client: {
  clientId: string
  clientSecret: string
}): FakeGoogle => {
  if (installed !== undefined) return installed
  const google: FakeGoogle = { ...client, log: [] }
  installed = google
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const target = `${url.origin}${url.pathname}`
    if (
      url.hostname.endsWith('google.com') ||
      url.hostname.endsWith('googleapis.com')
    ) {
      google.log.push(`${request.method} ${target}`)
    }
    if (target === GOOGLE_TOKEN) return tokenEndpoint(request, google)
    if (target === GOOGLE_JWKS)
      return Response.json({ keys: [(await signingKey()).jwk] })
    if (
      url.hostname.endsWith('google.com') ||
      url.hostname.endsWith('googleapis.com')
    ) {
      return new Response('fake Google: unexpected request', { status: 599 })
    }
    return realFetch(input, init)
  }) as typeof fetch
  return google
}
