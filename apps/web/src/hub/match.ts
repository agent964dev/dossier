import { pathsMeet } from '@dossier/contracts/bridge'

/**
 * The subscriptions a change concerns: a changed path equal to the
 * subscription's, below it (a folder ends in '/'), or above it, the tree's
 * root included. Each subscription at most once, in the order given.
 */
export const matching = (
  subscriptions: readonly (readonly [sub: number, path: string])[],
  changed: readonly string[],
): readonly number[] => {
  const out: number[] = []
  for (const [sub, path] of subscriptions) {
    if (out.includes(sub)) continue
    if (changed.some((c) => pathsMeet(path, c))) out.push(sub)
  }
  return out
}
