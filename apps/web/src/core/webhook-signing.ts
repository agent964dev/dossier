// Webhook secrets and signatures, as Standard Webhooks v1 defines them: the
// secret is `whsec_` and base64 bytes, and a signature is `v1,` and the
// base64 HMAC-SHA256 of `<id>.<timestamp>.<body>` keyed by those bytes.
import { Effect } from 'effect'

const PREFIX = 'whsec_'

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

/** A new secret: `whsec_` and the base64 of 24 random bytes. */
export const newWebhookSecret = (): string =>
  PREFIX + toBase64(crypto.getRandomValues(new Uint8Array(24)))

/** The signature header's value for one attempt. */
export const signWebhook = (i: {
  readonly secret: string
  readonly id: string
  /** Seconds since the epoch, as the webhook-timestamp header says. */
  readonly timestamp: number
  readonly body: string
}): Effect.Effect<string> =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      'raw',
      fromBase64(
        i.secret.startsWith(PREFIX) ? i.secret.slice(PREFIX.length) : i.secret,
      ),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const signed = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${i.id}.${i.timestamp}.${i.body}`),
    )
    return `v1,${toBase64(new Uint8Array(signed))}`
  })
