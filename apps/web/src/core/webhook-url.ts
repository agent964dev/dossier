// Where a webhook may send: an https URL on a public host that is not this
// deployment. Deliveries never follow redirects, so the host checked here is
// the only host a delivery reaches. A public name that resolves to a private
// address is not caught here: Workers' outbound fetch refuses those itself.

/** The longest URL a webhook keeps. */
export const WEBHOOK_URL_MAX = 2048

export interface WebhookUrlRules {
  /** The deployment's main host. */
  readonly origin: URL
  /** The pattern of each tree's own host, with `{tree}` in its first label. */
  readonly contentHost: string
}

/** Names that never leave the machine or the local network. */
const LOCAL_SUFFIXES = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'intranet',
  'lan',
  'home',
  'corp',
  'private',
  'home.arpa',
  'arpa',
  'test',
  'invalid',
  'example',
  'onion',
]

const isLoopbackName = (host: string) =>
  host === 'localhost' || host.endsWith('.localhost')

const ipv4 = (host: string): number[] | null => {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null
}

/** An IPv4 address that is not on the public internet. */
const privateIpv4 = ([a = 0, b = 0, c = 0]: number[]): boolean =>
  a === 0 ||
  a === 10 ||
  a === 127 ||
  (a === 100 && b >= 64 && b <= 127) ||
  (a === 169 && b === 254) ||
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && b === 0 && (c === 0 || c === 2)) ||
  (a === 192 && b === 88 && c === 99) ||
  (a === 192 && b === 168) ||
  (a === 198 && (b === 18 || b === 19)) ||
  (a === 198 && b === 51 && c === 100) ||
  (a === 203 && b === 0 && c === 113) ||
  a >= 224

/** The eight 16-bit groups of an IPv6 address, or null. */
const ipv6 = (host: string): number[] | null => {
  if (!host.startsWith('[') || !host.endsWith(']')) return null
  let text = host.slice(1, -1).toLowerCase()
  // The URL parser writes an embedded IPv4 address in hex, but be safe.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail !== null) {
    const v4 = ipv4(tail[1] ?? '')
    if (v4 === null) return null
    text =
      text.slice(0, -(tail[1] ?? '').length) +
      `${((v4[0] ?? 0) * 256 + (v4[1] ?? 0)).toString(16)}:${((v4[2] ?? 0) * 256 + (v4[3] ?? 0)).toString(16)}`
  }
  const [head = '', rest] = text.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = rest === undefined || rest === '' ? [] : rest.split(':')
  const fill = rest === undefined ? 0 : 8 - left.length - right.length
  const groups = [...left, ...Array<string>(fill).fill('0'), ...right].map(
    (g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN),
  )
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g))
    ? groups
    : null
}

/**
 * An IPv6 address outside global unicast, or one that carries an IPv4
 * address (mapped, NAT64, 6to4, Teredo) or is set aside for documentation.
 */
const privateIpv6 = (g: number[]): boolean => {
  const [a = 0, b = 0] = g
  if ((a & 0xe000) !== 0x2000) return true
  if (a === 0x2001 && (b === 0x0db8 || b === 0)) return true
  if (a === 0x2002) return true
  return false
}

/** The registrable part of the content host pattern: what follows its first label. */
const contentDomain = (pattern: string): string =>
  pattern.toLowerCase().replace(/:\d+$/, '').split('.').slice(1).join('.')

const isUnder = (host: string, domain: string) =>
  domain !== '' && (host === domain || host.endsWith(`.${domain}`))

/**
 * The URL as a webhook keeps it, or null when a webhook may not send there.
 * A deployment that itself runs on this machine may send to this machine,
 * over http too, so a local receiver can be checked.
 */
export const webhookUrl = (
  input: string,
  rules: WebhookUrlRules,
): string | null => {
  const text = input.trim()
  if (text === '' || text.length > WEBHOOK_URL_MAX) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.username !== '' || url.password !== '') return null
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const local = isLoopbackName(rules.origin.hostname.toLowerCase())
  const loopback =
    isLoopbackName(host) ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    (ipv4(host)?.[0] ?? -1) === 127
  if (local && loopback) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (
      host === rules.origin.hostname.toLowerCase() &&
      url.port === rules.origin.port
    ) {
      return null
    }
    if (isUnder(host, contentDomain(rules.contentHost))) return null
    return url.href
  }
  if (url.protocol !== 'https:') return null
  if (host === '' || host === rules.origin.hostname.toLowerCase()) return null
  if (isUnder(host, contentDomain(rules.contentHost))) return null
  const v4 = ipv4(host)
  if (v4 !== null) return privateIpv4(v4) ? null : url.href
  if (host.startsWith('[')) {
    const v6 = ipv6(host)
    return v6 === null || privateIpv6(v6) ? null : url.href
  }
  // A name with no dot is resolved on the local network, if anywhere.
  if (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) return null
  if (LOCAL_SUFFIXES.some((suffix) => isUnder(host, suffix))) return null
  // A name made only of digits and dots is an address the parser refused.
  if (/^[0-9.]+$/.test(host)) return null
  return url.href
}
