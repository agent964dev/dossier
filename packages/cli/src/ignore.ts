import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import ignore from 'ignore'

/** Never pushed, at any depth. */
export const ALWAYS_IGNORED: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
])

/** The file at a pushed folder's root that lists more to leave out. */
export const IGNORE_FILE = '.dossierignore'

/** Whether a path inside the pushed folder is left out of the push. */
export type IgnoreRule = (path: string, folder: boolean) => boolean

/**
 * The rule for one pushed folder: `.git`, `node_modules` and `.DS_Store`
 * anywhere, the `.dossierignore` file itself, and the patterns it lists in
 * gitignore syntax.
 */
export const ignoreRule = async (dir: string): Promise<IgnoreRule> => {
  let patterns = ''
  try {
    patterns = await readFile(join(dir, IGNORE_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const listed = ignore().add(patterns)
  return (path, folder) => {
    if (path === IGNORE_FILE) return true
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (ALWAYS_IGNORED.has(name)) return true
    return listed.ignores(folder ? `${path}/` : path)
  }
}
