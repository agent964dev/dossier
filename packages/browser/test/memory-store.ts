// An in-memory ShellStore for the shell's tests, with the same keys as the
// IndexedDB one.
import type { DraftValues, PendingSend } from '@dossier/contracts/bridge'
import type { ShellStore } from '../src/shell/store.ts'

export interface MemoryStore extends ShellStore {
  /** Drafts by `viewer|tree|page` → formKey → values. */
  readonly drafts: Map<string, Record<string, DraftValues>>
  /** Kept sends by `tree|page` → opId → send. */
  readonly pending: Map<string, Map<string, PendingSend>>
}

export const memoryStore = (): MemoryStore => {
  const drafts = new Map<string, Record<string, DraftValues>>()
  const pending = new Map<string, Map<string, PendingSend>>()
  const pageOf = (tree: string, page: string): Map<string, PendingSend> => {
    const key = `${tree}|${page}`
    let sends = pending.get(key)
    if (sends === undefined) {
      sends = new Map()
      pending.set(key, sends)
    }
    return sends
  }
  return {
    drafts,
    pending,
    loadDrafts: async (viewer, tree, page) => ({
      ...drafts.get(`${viewer}|${tree}|${page}`),
    }),
    saveDraft: async (viewer, tree, page, form, values) => {
      const key = `${viewer}|${tree}|${page}`
      const forms = { ...drafts.get(key) }
      if (values === null) delete forms[form]
      else forms[form] = values
      drafts.set(key, forms)
    },
    adoptDrafts: async (from, to, tree) => {
      if (from === to) return
      for (const [key, forms] of drafts) {
        const [viewer, inTree, ...page] = key.split('|')
        if (viewer !== from || inTree !== tree) continue
        const target = `${to}|${tree}|${page.join('|')}`
        drafts.set(target, { ...drafts.get(target), ...forms })
        drafts.delete(key)
      }
    },
    loadPending: async (tree, page) =>
      [...pageOf(tree, page).values()].sort((a, b) =>
        a.savedAt.localeCompare(b.savedAt),
      ),
    savePending: async (tree, page, send) => {
      pageOf(tree, page).set(send.opId, send)
    },
    clearPending: async (tree, page, opId) => {
      pageOf(tree, page).delete(opId)
    },
  }
}
