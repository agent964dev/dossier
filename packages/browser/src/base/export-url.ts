// Base files in a page downloaded as one file. Each library, base component,
// grammar and stylesheet is named under the export prefix, and the file's
// import map turns each name into a data: URL, so nothing is fetched from a
// server. A live page keeps its base layer's paths as they are.

/** Where libraries and base components are named in an exported page. */
export const EXPORT_BASE = 'dossier-export/base'

/**
 * The URL of a base file at `path` under `base`: the live path, or in an
 * exported page the data: URL the file's import map gives its name. Throws
 * when an exported page's import map does not name the file.
 */
export const baseFileUrl = (base: string, path: string): string => {
  const name = `${base}/${path}`
  return base === EXPORT_BASE ? import.meta.resolve(name) : name
}

/**
 * The base folder a base component's own module sits in: beside its live
 * URL, or the export prefix when it was loaded from a data: URL.
 */
export const baseOfModule = (moduleUrl: string): string =>
  moduleUrl.startsWith('data:')
    ? EXPORT_BASE
    : new URL('..', moduleUrl).href.replace(/\/$/, '')

/**
 * The file name an exported page keeps in a data: URL's `name` parameter
 * (`data:text/markdown;name=v1%2Fplan.md;base64,…` → 'v1/plan.md'), or null.
 */
export const nameInDataUrl = (url: string): string | null => {
  if (!url.startsWith('data:')) return null
  const comma = url.indexOf(',')
  if (comma === -1) return null
  for (const param of url.slice('data:'.length, comma).split(';').slice(1)) {
    const equals = param.indexOf('=')
    if (equals === -1) continue
    if (param.slice(0, equals).trim().toLowerCase() !== 'name') continue
    try {
      return decodeURIComponent(param.slice(equals + 1))
    } catch {
      return null
    }
  }
  return null
}
