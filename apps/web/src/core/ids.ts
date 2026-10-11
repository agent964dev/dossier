import type { TreeId } from '@dossier/contracts'

const base64url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

const randomBytes = (length: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(length))

/** A random row id: 16 bytes in base64url. */
export const newId = (): string => base64url(randomBytes(16))

/** A new agent key secret: `dsk_` and 32 random bytes in base64url. */
export const newKeySecret = (): `dsk_${string}` =>
  `dsk_${base64url(randomBytes(32))}`

export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export const hmacSha256 = async (
  secret: string,
  value: string,
): Promise<string> => {
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
    new TextEncoder().encode(value),
  )
  return base64url(new Uint8Array(signature))
}

const TREE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * A new tree's ID: 20 characters drawn uniformly from lowercase letters and
 * digits (about 103 random bits), so it is a DNS label of the content host.
 */
export const newTreeId = (): TreeId => {
  let id = ''
  while (id.length < 20) {
    for (const byte of randomBytes(32)) {
      // 252 is the largest multiple of 36 below 256: no bias.
      if (byte < 252 && id.length < 20) id += TREE_ALPHABET[byte % 36]
    }
  }
  return id as TreeId
}
