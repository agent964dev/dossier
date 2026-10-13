// What a listing's kit row names. Pure, so tests read it directly.
import type { KitItem } from '../core/index.ts'

/** Within one folder: the layout, the theme, other files, then folders. */
const kitRank = (name: string): number =>
  name === '_layout.html'
    ? 0
    : name === '_theme.css'
      ? 1
      : name.endsWith('/')
        ? 3
        : 2

/**
 * The names a kit row shows: each `_` file or folder of the tree, by its
 * first name ('_components/' for a component), closest folder first, once
 * each.
 */
export const kitNames = (items: readonly KitItem[]): string[] => {
  const found: { name: string; depth: number }[] = []
  for (const item of items) {
    if (item.from === null) continue
    const slash = item.path.indexOf('/')
    const name = slash < 0 ? item.path : `${item.path.slice(0, slash)}/`
    if (found.some((f) => f.name === name)) continue
    found.push({
      name,
      depth: item.from === '' ? 0 : item.from.split('/').length,
    })
  }
  return found
    .sort(
      (a, b) =>
        b.depth - a.depth ||
        kitRank(a.name) - kitRank(b.name) ||
        (a.name < b.name ? -1 : 1),
    )
    .map((f) => f.name)
}
