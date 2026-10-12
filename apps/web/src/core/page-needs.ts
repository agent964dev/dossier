// What a page shared on its own renders with, as tree paths: the files its
// markup loads, never what it links to. A push records them per blob and
// folder in `render_paths`, which the read rule joins (access.ts).
import { isNodeName, MAX_DEPTH } from '@dossier/contracts'
import type { HtmlAnalysis } from '@dossier/html'

export interface RenderPath {
  /**
   * A tree path as the browser asks for it: 'a/photo.png', 'plan' (the link
   * route reads it as plan or plan.html), or 'docs/' for a folder.
   */
  readonly path: string
  /**
   * Named in an inline style or module script, which a composed layout's
   * are read from the page's folder, so only a page's own count.
   */
  readonly inline: boolean
}

/** How many of a file's own references are recorded. */
const MAX_PATHS = 200

/** A pathname inside the tree as tree path segments, or null. */
const treePathOf = (
  pathname: string,
): { readonly path: string; readonly folder: boolean } | null => {
  const folder = pathname === '' || pathname.endsWith('/')
  const bare = folder ? pathname.slice(0, -1) : pathname
  if (bare === '') return { path: '', folder: true }
  const names: string[] = []
  for (const segment of bare.split('/')) {
    let name: string
    try {
      name = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (!isNodeName(name)) return null
    names.push(name)
  }
  if (names.length > MAX_DEPTH) return null
  return { path: names.join('/'), folder }
}

/**
 * The rendering dependencies of an HTML file in `folder`: relative URLs the
 * analysis marks `render` (src, srcset, poster, frames, stylesheets, icons,
 * preloads, SVG images and uses) and its inline style and module imports,
 * resolved from the folder. `_` paths are left out: read on the page
 * reaches those already.
 */
export const renderPathsOf = (
  analysis: HtmlAnalysis,
  folder: string,
): readonly RenderPath[] => {
  const base = `https://tree.invalid/${folder === '' ? '' : `${folder.split('/').map(encodeURIComponent).join('/')}/`}`
  const out = new Map<string, RenderPath>()
  const requested = [
    ...analysis.urls
      .filter((url) => url.use === 'render' && url.relative && !url.underscore)
      .flatMap((url) =>
        url.requests.map((value) => ({ value, inline: false })),
      ),
    ...analysis.inlineRefs
      .filter((ref) => ref.relative && !ref.underscore)
      .map((ref) => ({ value: ref.url, inline: true })),
  ]
  for (const { value, inline } of requested) {
    if (out.size >= MAX_PATHS) break
    let target: URL
    try {
      target = new URL(value, base)
    } catch {
      continue
    }
    if (target.origin !== 'https://tree.invalid') continue
    const ref = treePathOf(target.pathname.slice(1))
    if (ref === null || ref.path === '') continue
    if (ref.path.split('/').some((name) => name.startsWith('_'))) continue
    const path = ref.folder ? `${ref.path}/` : ref.path
    const key = `${path}\u0000${inline}`
    if (!out.has(key)) out.set(key, { path, inline })
  }
  return [...out.values()]
}
