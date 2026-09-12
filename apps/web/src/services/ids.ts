import { customRandom } from 'nanoid'
import { Context, Effect, Layer } from 'effect'

const DOCUMENT_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const INTERNAL_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-'
const encoder = new TextEncoder()

function webCryptoRandom(bytes: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(bytes))
}

const documentNanoid = customRandom(DOCUMENT_ALPHABET, 12, webCryptoRandom)
const internalNanoid = customRandom(INTERNAL_ALPHABET, 20, webCryptoRandom)

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export interface IdsService {
  readonly documentId: () => string
  readonly internalId: (prefix?: string) => string
  readonly apiToken: () => string
  readonly randomToken: (bytes: number) => string
  readonly sha256Hex: (
    value: string | Uint8Array | ArrayBuffer,
  ) => Effect.Effect<string>
  readonly sha256Base64Url: (
    value: string | Uint8Array | ArrayBuffer,
  ) => Effect.Effect<string>
}

export class Ids extends Context.Tag('@dossier/web/Ids')<Ids, IdsService>() {}

function asBytes(value: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof value === 'string') return encoder.encode(value)
  if (value instanceof Uint8Array) return value
  return new Uint8Array(value)
}

export const makeIds = (): IdsService => ({
  documentId: () => documentNanoid(),
  internalId: (prefix = '') => `${prefix}${internalNanoid()}`,
  apiToken: () => `ds_${base64Url(webCryptoRandom(32))}`,
  randomToken: (bytes) => base64Url(webCryptoRandom(bytes)),
  sha256Hex: (value) =>
    Effect.promise(async () => {
      const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(asBytes(value)).buffer)
      return bytesToHex(new Uint8Array(digest))
    }),
  sha256Base64Url: (value) =>
    Effect.promise(async () => {
      const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(asBytes(value)).buffer)
      return base64Url(new Uint8Array(digest))
    }),
})

export const IdsLive = Layer.succeed(Ids, makeIds())
