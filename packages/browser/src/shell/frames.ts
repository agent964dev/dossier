/**
 * True when `candidate` is `root` or a frame nested inside it. Walks
 * `candidate.parent` upward, which stays readable on windows of other origins,
 * at most `maxDepth` steps.
 */
export const within = (
  root: Window,
  candidate: MessageEventSource | null,
  maxDepth = 8,
): boolean => {
  let current: unknown = candidate
  for (let step = 0; current !== null && current !== undefined; step++) {
    if (current === root) return true
    if (step >= maxDepth) return false
    let parent: unknown
    try {
      parent = (current as { readonly parent?: unknown }).parent
    } catch {
      return false
    }
    // The top window is its own parent; ports and workers have none.
    if (parent === current) return false
    current = parent
  }
  return false
}
