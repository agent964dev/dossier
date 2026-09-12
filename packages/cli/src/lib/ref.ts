import { CliError, ExitCode } from './errors.js'

const DOCUMENT_ID = '[a-z0-9]{12}'
const SHORT_REF = new RegExp(`^(${DOCUMENT_ID})(?:@([1-9]\\d*))?$`)
const URL_PATH = new RegExp(`^/d/(${DOCUMENT_ID})(?:/v/([1-9]\\d*))?(?:/(raw|tree))?/?$`)

export interface DocumentRef {
  readonly id: string
  readonly version?: number
  readonly suffix?: 'raw' | 'tree'
  readonly source: 'id' | 'url'
}

function usage(message: string): never {
  throw new CliError(message, ExitCode.Usage)
}

export function parseRef(ref: string, apiUrl: string): DocumentRef {
  const short = SHORT_REF.exec(ref)
  if (short) {
    return {
      id: short[1]!,
      ...(short[2] === undefined ? {} : { version: Number(short[2]) }),
      source: 'id',
    }
  }

  let url: URL
  let configured: URL
  try {
    url = new URL(ref)
  } catch {
    return usage(`not a dossier document ID or URL: ${ref}`)
  }
  try {
    configured = new URL(apiUrl)
  } catch {
    return usage(`invalid configured API URL: ${apiUrl}`)
  }

  if (url.origin !== configured.origin) {
    return usage(
      `document URL origin ${url.origin} does not match configured dossier origin ${configured.origin}`,
    )
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return usage(`not a canonical dossier document URL: ${ref}`)
  }

  const path = URL_PATH.exec(url.pathname)
  if (!path) return usage(`not a dossier document URL: ${ref}`)

  return {
    id: path[1]!,
    ...(path[2] === undefined ? {} : { version: Number(path[2]) }),
    ...(path[3] === undefined ? {} : { suffix: path[3] as 'raw' | 'tree' }),
    source: 'url',
  }
}
