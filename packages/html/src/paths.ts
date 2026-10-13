// The segment and path rules of a tree, the same as @dossier/contracts'
// grammar. This package imports nothing of ours, so it keeps its own copy;
// the CLI's tests hold the two equal.

/** The deepest a node sits below its tree's root. */
export const MAX_DEPTH = 32

// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const encoder = new TextEncoder()

/**
 * A folder or file name: not empty, `.` or `..`; no `/`, NUL or control
 * characters; at most 255 bytes of UTF-8.
 */
export const isNodeName = (name: string): boolean =>
  name !== '' &&
  name !== '.' &&
  name !== '..' &&
  !name.includes('/') &&
  !CONTROL.test(name) &&
  encoder.encode(name).length <= 255

/** A `_` file or folder. */
export const isKitName = (name: string): boolean => name.startsWith('_')

/** A page is a `.html` file. */
export const isPageFile = (path: string): boolean => path.endsWith('.html')

/** The folder a path sits in: '' for the root. */
export const parentOf = (path: string): string => {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}

/** `a/b` joined to `c` is `a/b/c`; the root is ''. */
export const joinPath = (folder: string, name: string): string =>
  folder === '' ? name : name === '' ? folder : `${folder}/${name}`
