// Plain TypeScript with no Effect import, so browser code can use it.

/** One protocol version; the CLI's release version is separate. */
export const PROTOCOL = 1 as const
export const PROTOCOL_HEADER = 'Dossier-Protocol'
/** Sent with the value `1` on every write a browser makes. */
export const CSRF_HEADER = 'Dossier-CSRF'
export const DEFAULT_DEPLOYMENT = 'dossier.agent964.com'
