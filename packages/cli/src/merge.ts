import { diff3Merge } from 'node-diff3'

/**
 * What a three-way merge does with one path, from its hash at the base, in
 * the folder (ours) and in the tree (theirs); null where it is absent.
 */
export type Step =
  /** Both sides hold the same: nothing to do. */
  | 'nothing'
  /** Only the folder changed it, added it or deleted it. */
  | 'keep'
  /** Only the tree changed it or added it. */
  | 'take'
  /** Only the tree deleted it. */
  | 'delete'
  /** Both changed it, and both still hold it. */
  | 'merge'
  /** The folder deleted it and the tree changed it: theirs comes back. */
  | 'restore'
  /** The folder changed it and the tree deleted it: ours stays. */
  | 'hold'

/**
 * The step for one path. `base` is undefined when the folder has no base
 * copy: then nothing is known of who changed what, and any two different
 * files are merged as if both sides had added them.
 */
export const decide = (
  base: string | null | undefined,
  ours: string | null,
  theirs: string | null,
): Step => {
  if (ours === theirs) return 'nothing'
  if (base === undefined) {
    if (ours === null) return 'take'
    if (theirs === null) return 'keep'
    return 'merge'
  }
  if (ours === base) return theirs === null ? 'delete' : 'take'
  if (theirs === base) return 'keep'
  if (ours === null) return 'restore'
  if (theirs === null) return 'hold'
  return 'merge'
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** The file as text, byte for byte, or null for a binary file. */
export const textOf = (bytes: Uint8Array): string | null => {
  if (bytes.includes(0)) return null
  try {
    return utf8.decode(bytes)
  } catch {
    return null
  }
}

/** Lines with their line endings, so joining them gives the text back. */
const linesOf = (text: string): string[] =>
  text === '' ? [] : text.split(/(?<=\n)/)

export const MARK_OURS = '<<<<<<< local'
export const MARK_SPLIT = '======='
export const MARK_THEIRS = '>>>>>>>'

/**
 * A line merge of two texts changed from one base. Where both changed the
 * same lines, both versions stay between git-style markers: ours under
 * `<<<<<<< local`, theirs above `>>>>>>> <label>`. The same change on both
 * sides is not a conflict. With no base text (`null`), nothing is known of
 * who changed which line, so two different texts are one conflict.
 */
export const mergeText = (
  base: string | null,
  ours: string,
  theirs: string,
  label: string,
): { readonly text: string; readonly conflicts: number } => {
  const eol = ours.includes('\r\n') || theirs.includes('\r\n') ? '\r\n' : '\n'
  const ended = (lines: readonly string[]) =>
    lines.length === 0 || lines[lines.length - 1]!.endsWith('\n')
      ? lines
      : [...lines.slice(0, -1), `${lines[lines.length - 1]}${eol}`]
  if (base === null) {
    return ours === theirs
      ? { text: ours, conflicts: 0 }
      : {
          text: [
            `${MARK_OURS}${eol}`,
            ...ended(linesOf(ours)),
            `${MARK_SPLIT}${eol}`,
            ...ended(linesOf(theirs)),
            `${MARK_THEIRS} ${label}${eol}`,
          ].join(''),
          conflicts: 1,
        }
  }
  let conflicts = 0
  const parts: string[] = []
  for (const region of diff3Merge(
    linesOf(ours),
    linesOf(base),
    linesOf(theirs),
    { excludeFalseConflicts: true },
  )) {
    if (region.ok !== undefined) {
      parts.push(...region.ok)
    } else if (region.conflict !== undefined) {
      conflicts += 1
      parts.push(
        `${MARK_OURS}${eol}`,
        ...ended(region.conflict.a),
        `${MARK_SPLIT}${eol}`,
        ...ended(region.conflict.b),
        `${MARK_THEIRS} ${label}${eol}`,
      )
    }
  }
  return { text: parts.join(''), conflicts }
}

/** Whether a merged text still holds a marker line the merge wrote. */
export const hasMarkers = (text: string): boolean =>
  new RegExp(`^(${MARK_OURS}|${MARK_THEIRS} .*)\\r?$`, 'm').test(text)

/**
 * Where theirs goes beside a binary file both sides changed:
 * `img/logo.png` → `img/logo.theirs.png`, `LICENSE` → `LICENSE.theirs`; a
 * number follows when that path is taken.
 */
export const theirsPath = (
  path: string,
  taken: (path: string) => boolean,
): string => {
  const slash = path.lastIndexOf('/')
  const folder = path.slice(0, slash + 1)
  const name = path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const [stem, ext] =
    dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 1; ; n += 1) {
    const candidate = `${folder}${stem}.theirs${n === 1 ? '' : `-${n}`}${ext}`
    if (!taken(candidate)) return candidate
  }
}
