import type { FontRole } from './look'

/** A Google Fonts family as the catalogue lists it, most used first. */
export type GoogleFamily = readonly [
  family: string,
  category: string,
  arabic: boolean,
]

/** The catalogue, loaded only when a font list first opens. */
export const loadGoogleFamilies = async (): Promise<readonly GoogleFamily[]> =>
  (await import('./google-fonts.json')).default as unknown as GoogleFamily[]

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

/**
 * How well `query` matches a family name, higher is better, or null when it
 * does not. The whole name first, then the query at the start of a word,
 * then inside a word, then its letters in order (as "opn sns" finds Open
 * Sans), closer together scoring higher.
 */
export const fuzzyScore = (query: string, name: string): number | null => {
  const q = fold(query)
  if (q === '') return 0
  const n = fold(name)
  if (n === q) return 1000
  const at = n.indexOf(q)
  if (at === 0 || (at > 0 && n.includes(` ${q}`))) return 700
  if (at > 0) return 400
  let score = 300
  let from = 0
  for (const char of q.replaceAll(' ', '')) {
    const found = n.indexOf(char, from)
    if (found === -1) return null
    // Letters skipped since the last match cost a point each, spaces none.
    score -= n.slice(from, found).replaceAll(' ', '').length
    from = found + 1
  }
  return Math.max(score, 1)
}

/** Whether a family suits a role: a monospace for Mono, Arabic for Arabic. */
export const suitsRole = (role: FontRole, entry: GoogleFamily) =>
  role === 'mono'
    ? entry[1] === 'Monospace'
    : role === 'arabic'
      ? entry[2]
      : true

/**
 * The families matching `query`, best first: the exact name, then those
 * that suit the role, then by score, then the catalogue's order.
 */
export const searchFamilies = (
  families: readonly GoogleFamily[],
  query: string,
  role: FontRole,
): readonly GoogleFamily[] => {
  const ranked: { entry: GoogleFamily; score: number; suits: boolean }[] = []
  for (const entry of families) {
    const score = fuzzyScore(query, entry[0])
    if (score !== null) {
      ranked.push({ entry, score, suits: suitsRole(role, entry) })
    }
  }
  // Array sort is stable, so equal families keep the catalogue's order.
  return ranked
    .sort(
      (a, b) =>
        Number(b.score === 1000) - Number(a.score === 1000) ||
        Number(b.suits) - Number(a.suits) ||
        b.score - a.score,
    )
    .map((match) => match.entry)
}
