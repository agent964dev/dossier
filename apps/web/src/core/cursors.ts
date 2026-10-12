// Event cursors as callers hold them: sealed, so they say nothing about how
// many events a tree holds, and bound to the tree they were given for.
import type { TreeId } from '@dossier/contracts'

const encoder = new TextEncoder()
const keys = new Map<string, Promise<CryptoKey>>()

/** AES-GCM, derived from the deployment's handle secret for cursors only. */
const keyFor = (secret: string): Promise<CryptoKey> => {
  let key = keys.get(secret)
  if (key === undefined) {
    key = crypto.subtle
      .importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
      .then((base) =>
        crypto.subtle.deriveKey(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new Uint8Array(),
            info: encoder.encode('dossier event cursor'),
          },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt'],
        ),
      )
    keys.set(secret, key)
  }
  return key
}

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')

const fromBase64Url = (text: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null
  try {
    const raw = atob(text.replaceAll('-', '+').replaceAll('_', '/'))
    return Uint8Array.from(raw, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/**
 * Seals a position in a tree's events. The plain text has one length for
 * every position and a fresh nonce each time, so two cursors for the same
 * place differ and none shows a count.
 */
export const sealCursor = async (
  secret: string,
  treeId: TreeId,
  seq: number,
): Promise<string> => {
  const plain = new Uint8Array(28)
  plain.set(encoder.encode(treeId.padEnd(20).slice(0, 20)))
  new DataView(plain.buffer).setBigUint64(20, BigInt(seq))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await keyFor(secret),
      plain,
    ),
  )
  const out = new Uint8Array(iv.length + sealed.length)
  out.set(iv)
  out.set(sealed, iv.length)
  return toBase64Url(out)
}

/** The position a cursor seals, or null when it is not this tree's own. */
export const openCursor = async (
  secret: string,
  treeId: TreeId,
  cursor: string,
): Promise<number | null> => {
  const bytes = fromBase64Url(cursor)
  if (bytes === null || bytes.length !== 12 + 28 + 16) return null
  try {
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.slice(0, 12) },
        await keyFor(secret),
        bytes.slice(12),
      ),
    )
    const tree = new TextDecoder().decode(plain.slice(0, 20)).trimEnd()
    if (tree !== treeId) return null
    const seq = new DataView(plain.buffer).getBigUint64(20)
    return seq > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(seq)
  } catch {
    return null
  }
}
