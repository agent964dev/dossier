// Better Auth's signed session cookie: `<token>.<base64 HMAC-SHA256 of the
// token with the secret>`, URL-encoded. Pure WebCrypto, so a test can check it
// against the real sign-in.

export const SESSION_COOKIE = '__Secure-dossier.session_token'

export async function signedSessionCookie(
  token: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(token),
  )
  let binary = ''
  for (const byte of new Uint8Array(signature)) {
    binary += String.fromCharCode(byte)
  }
  return encodeURIComponent(`${token}.${btoa(binary)}`)
}
