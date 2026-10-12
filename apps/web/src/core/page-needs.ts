// What a page shared on its own carries, as tree paths: the files its markup
// and its layouts' load (never what they link to), and where their forms
// write. A push records them for every page of the tree in `page_needs`,
// which the read rule joins (access.ts).
import { isNodeName, MAX_DEPTH } from '@dossier/contracts'
import { resolveFormAction, type HtmlAnalysis } from '@dossier/html'

export interface RenderPath {
  /**
   * A tree path as the browser asks for it: 'a/photo.png', 'plan' (the link
   * route reads it as plan or plan.html), or 'docs/' for a folder.
   */
  readonly path: string
  /**
   * Named in an inline style or module script, which a composed layout's
   * are read from the page's folder.
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

/** One thing a page carries: a file it renders with, or a form target. */
export interface PageNeed {
  /** The page's tree path. */
  readonly page: string
  /** A node's tree path: a folder's or a file's. */
  readonly need: string
  /** render: a file or folder; folder or json: where a form writes. */
  readonly kind: 'render' | 'folder' | 'json'
}

const parentOf = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

const joinPath = (folder: string, name: string): string =>
  folder === '' ? name : `${folder}/${name}`

/**
 * What every page of a tree carries, from its HTML files as a push leaves
 * them. A page takes its folder's `_layout.html` and each above it up to
 * the first complete one (none when the page itself is complete), as
 * composition does. A path names a node as the link route reads it: the
 * page of that name first, then a folder (the folder alone), then a file.
 */
export const pageNeedsOf = (
  files: readonly { readonly path: string; readonly analysis: HtmlAnalysis }[],
  kindAt: (path: string) => string | null,
): readonly PageNeed[] => {
  const byPath = new Map(files.map((f) => [f.path, f]))
  const out = new Map<string, PageNeed>()
  const add = (need: PageNeed) =>
    out.set(`${need.page}\u0000${need.need}\u0000${need.kind}`, need)
  // A folder is the folder and the page it shows, never the rest of it.
  const folderNeeds = (folder: string): readonly string[] =>
    kindAt(joinPath(folder, 'index.html')) === 'page'
      ? [folder, joinPath(folder, 'index.html')]
      : [folder]
  const resolve = (path: string): readonly string[] => {
    if (path.endsWith('/')) {
      const folder = path.slice(0, -1)
      return kindAt(folder) === 'folder' ? folderNeeds(folder) : []
    }
    if (kindAt(`${path}.html`) === 'page') return [`${path}.html`]
    const kind = kindAt(path)
    if (kind === 'folder') return folderNeeds(path)
    return kind === 'file' || kind === 'page' ? [path] : []
  }
  for (const page of files) {
    if (!page.path.endsWith('.html')) continue
    if (page.path.split('/').some((name) => name.startsWith('_'))) continue
    const chain: { readonly path: string; readonly analysis: HtmlAnalysis }[] =
      []
    if (!page.analysis.complete) {
      let folder: string | null = parentOf(page.path)
      while (folder !== null) {
        const layout = byPath.get(joinPath(folder, '_layout.html'))
        if (layout !== undefined) {
          chain.push(layout)
          if (layout.analysis.complete) break
        }
        folder = folder === '' ? null : parentOf(folder)
      }
    }
    // A layout's attribute URLs are rewritten to its own folder when it is
    // composed; what its inline styles and scripts name is read from the
    // page's folder.
    const rendered = [
      ...renderPathsOf(page.analysis, parentOf(page.path)),
      ...chain.flatMap((layout) => [
        ...renderPathsOf(layout.analysis, parentOf(layout.path)).filter(
          (r) => !r.inline,
        ),
        ...renderPathsOf(layout.analysis, parentOf(page.path)).filter(
          (r) => r.inline,
        ),
      ]),
    ]
    for (const r of rendered) {
      for (const need of resolve(r.path)) {
        if (need !== page.path) add({ page: page.path, need, kind: 'render' })
      }
    }
    for (const host of [page, ...chain]) {
      for (const form of host.analysis.forms) {
        if (form.action === null) continue
        const target = resolveFormAction(host.path, form.action)
        if ('problem' in target) continue
        add({
          page: page.path,
          need: target.target,
          kind: target.kind === 'folder' ? 'folder' : 'json',
        })
      }
    }
  }
  return [...out.values()]
}
