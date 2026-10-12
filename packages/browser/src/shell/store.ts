// What the shell keeps on this device, in its own IndexedDB: each viewer's
// drafts, and the sends it still has to deliver. It keeps nothing else.
import {
  VISITOR_VIEWER,
  type DraftValues,
  type PendingSend,
} from '@dossier/contracts/bridge'

export interface ShellStore {
  /**
   * A viewer's drafts on a page, by formKey. The viewer is the person's email,
   * or VISITOR_VIEWER for someone not signed in.
   */
  readonly loadDrafts: (
    viewer: string,
    treeId: string,
    page: string,
  ) => Promise<Record<string, DraftValues>>
  /** Keeps a form's draft, or forgets it for null. */
  readonly saveDraft: (
    viewer: string,
    treeId: string,
    page: string,
    form: string,
    values: DraftValues | null,
  ) => Promise<void>
  /**
   * Hands what a visitor kept in a tree to the person who signed in: each
   * draft becomes theirs unless they have their own for that form, which
   * stays (the visitor's is dropped), and each of the visitor's kept sends
   * becomes theirs to send.
   */
  readonly claimVisitor: (viewer: string, treeId: string) => Promise<void>
  /** The sends kept for a page, oldest first. */
  readonly loadPending: (treeId: string, page: string) => Promise<PendingSend[]>
  readonly savePending: (
    treeId: string,
    page: string,
    send: PendingSend,
  ) => Promise<void>
  readonly clearPending: (
    treeId: string,
    page: string,
    opId: string,
  ) => Promise<void>
}

export const DATABASE = 'dossier-shell'
const DRAFTS = 'drafts'
const PENDING = 'pending'

interface DraftRecord {
  readonly viewer: string
  readonly tree: string
  readonly page: string
  readonly form: string
  readonly values: DraftValues
}

interface PendingRecord {
  readonly tree: string
  readonly page: string
  readonly opId: string
  /** File values stay Files: IndexedDB keeps them as they are. */
  readonly send: PendingSend
}

const settle = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () => reject(request.error))
  })

const finished = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve())
    transaction.addEventListener('error', () => reject(transaction.error))
    transaction.addEventListener('abort', () => reject(transaction.error))
  })

/** The shell's store on IndexedDB. */
export const browserStore = (indexedDB: IDBFactory): ShellStore => {
  let opened: Promise<IDBDatabase> | null = null
  const database = (): Promise<IDBDatabase> => {
    opened ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1)
      request.addEventListener('upgradeneeded', () => {
        const db = request.result
        const drafts = db.createObjectStore(DRAFTS, {
          keyPath: ['viewer', 'tree', 'page', 'form'],
        })
        drafts.createIndex('page', ['viewer', 'tree', 'page'])
        drafts.createIndex('tree', ['viewer', 'tree'])
        const pending = db.createObjectStore(PENDING, {
          keyPath: ['tree', 'page', 'opId'],
        })
        pending.createIndex('page', ['tree', 'page'])
      })
      request.addEventListener('success', () => resolve(request.result))
      request.addEventListener('error', () => {
        opened = null
        reject(request.error)
      })
    })
    return opened
  }

  const run = async <T>(
    name: string,
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> => {
    const db = await database()
    const transaction = db.transaction(name, mode)
    const done = finished(transaction)
    const result = await work(transaction.objectStore(name))
    await done
    return result
  }

  return {
    loadDrafts: (viewer, treeId, page) =>
      run(DRAFTS, 'readonly', async (store) => {
        const records = (await settle(
          store.index('page').getAll([viewer, treeId, page]),
        )) as DraftRecord[]
        return Object.fromEntries(
          records.map((record) => [record.form, record.values]),
        )
      }),
    saveDraft: (viewer, treeId, page, form, values) =>
      run(DRAFTS, 'readwrite', async (store) => {
        if (values === null) {
          await settle(store.delete([viewer, treeId, page, form]))
          return
        }
        const record: DraftRecord = { viewer, tree: treeId, page, form, values }
        await settle(store.put(record))
      }),
    claimVisitor: async (viewer, treeId) => {
      if (viewer === VISITOR_VIEWER) return
      const db = await database()
      const transaction = db.transaction([DRAFTS, PENDING], 'readwrite')
      const done = finished(transaction)
      const drafts = transaction.objectStore(DRAFTS)
      const visitor = (await settle(
        drafts.index('tree').getAll([VISITOR_VIEWER, treeId]),
      )) as DraftRecord[]
      for (const record of visitor) {
        const own = [viewer, treeId, record.page, record.form]
        if ((await settle(drafts.getKey(own))) === undefined) {
          await settle(drafts.put({ ...record, viewer }))
        }
        await settle(
          drafts.delete([VISITOR_VIEWER, treeId, record.page, record.form]),
        )
      }
      // A device keeps few sends: reading them all needs no key range, whose
      // constructor belongs to the IndexedDB the store was given.
      const pending = transaction.objectStore(PENDING)
      const kept = (await settle(pending.getAll())) as PendingRecord[]
      for (const record of kept) {
        if (record.tree !== treeId || record.send.by !== null) continue
        const claimed: PendingRecord = {
          ...record,
          send: { ...record.send, by: viewer },
        }
        await settle(pending.put(claimed))
      }
      await done
    },
    loadPending: (treeId, page) =>
      run(PENDING, 'readonly', async (store) => {
        const records = (await settle(
          store.index('page').getAll([treeId, page]),
        )) as PendingRecord[]
        return records
          .map((record) => record.send)
          .sort((a, b) => a.savedAt.localeCompare(b.savedAt))
      }),
    savePending: (treeId, page, send) =>
      run(PENDING, 'readwrite', async (store) => {
        const record: PendingRecord = {
          tree: treeId,
          page,
          opId: send.opId,
          send,
        }
        await settle(store.put(record))
      }),
    clearPending: (treeId, page, opId) =>
      run(PENDING, 'readwrite', async (store) => {
        await settle(store.delete([treeId, page, opId]))
      }),
  }
}
