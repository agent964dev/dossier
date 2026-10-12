// Page code's data calls: paths, the local value of each file, coalesced
// writes with their optimistic values and rollback, and watchers.
import {
  DossierError,
  ERRORS,
  docFromWire,
  relativeToPage,
  resolvePath,
  toPageError,
  type Doc,
  type DocWire,
  type ErrorFields,
  type Json,
  type JsonObject,
  type Me,
  type PageBootstrap,
  type PageErrorCode,
  type PageOp,
  type ShellToPage,
} from '@dossier/contracts/bridge'
import {
  applyMergePatch,
  composeMergePatch,
  isJsonObject,
} from './merge-patch.ts'
import type { Requests } from './requests.ts'

export type Changed = Extract<ShellToPage, { type: 'changed' }>

export interface Uploaded {
  /** The stored file, relative to the page like a URL. */
  readonly file: string
  readonly name: string
  readonly size: number
  readonly type: string
}

export type WatchValue = Doc | Doc[] | null

export interface PageData {
  readonly read: (path: string) => Promise<Doc | Doc[] | null>
  readonly watch: (
    path: string,
    onChange: (value: WatchValue) => void,
  ) => () => void
  readonly write: (
    path: string,
    patch: JsonObject,
    opts?: { readonly replace?: true },
  ) => Promise<Doc>
  readonly withdraw: (path: string) => Promise<void>
  readonly upload: (file: File | Blob) => Promise<Uploaded>
  /** Takes the shell's `changed` messages. */
  readonly changed: (message: Changed) => void
}

/** What page code can do about each code, when the answer names nothing. */
export const FIXES: Readonly<Record<PageErrorCode, string>> = {
  forbidden: 'Write only your own files, or shared files you may respond to.',
  invalid: 'Correct the value that path names, then try again.',
  not_mergeable:
    'Write a JSON object into a file that holds one, or pass { replace: true } for your own file.',
  closed: 'The form for this file is closed; it takes nothing more.',
  too_large: 'Write less, or read a smaller folder.',
  rate_limited: 'Wait a minute, then try again.',
  sign_in_required: 'Sign in, then try again.',
  offline: 'Connect to the internet, then try again.',
  not_in_export: 'Open the live page in Dossier for this.',
  unavailable: 'Try again in a moment.',
}

interface Call {
  /** The path as page code named it. */
  readonly input: string
  readonly resolve: (doc: Doc) => void
  readonly reject: (error: DossierError) => void
}

/** Patches sent as one request, and the calls that request answers. */
interface Batch {
  patch: JsonObject
  replace: boolean
  readonly calls: Call[]
}

/** One file's values: stored, and as page code sees it while writes go. */
interface FileState {
  /** The stored file; null when missing, undefined while not known. */
  confirmed: DocWire | null | undefined
  /** The stored value with every pending patch applied. */
  local: Json | undefined
  /** When the newest pending write was made. */
  at: string
  inflight: Batch | null
  queue: Batch[]
}

interface Watcher {
  /** A tree path; a folder ends in '/'. */
  readonly path: string
  readonly onChange: (value: WatchValue) => void
  /** A folder's files by tree path, sorted; undefined until the first value. */
  files: { readonly path: string; readonly doc: Doc }[] | undefined
}

const isFolder = (path: string): boolean => path === '' || path.endsWith('/')

const isDocWire = (value: unknown): value is DocWire =>
  isJsonObject(value) &&
  typeof value.path === 'string' &&
  typeof value.by === 'string' &&
  typeof value.at === 'string' &&
  typeof value.push === 'number'

const isBlob = (value: unknown): value is Blob =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Partial<Blob>).arrayBuffer === 'function' &&
  typeof (value as Partial<Blob>).size === 'number'

const UNAVAILABLE: ErrorFields = {
  code: 'unavailable',
  message: ERRORS.unavailable.message,
  fix: null,
  path: null,
}

export const createPageData = (deps: {
  readonly bootstrap: PageBootstrap
  readonly requests: Requests
  readonly me: () => Me | null
  /** True once identity is in place; calls before it wait for `ready`. */
  readonly isReady: () => boolean
  readonly ready: Promise<void>
  /** False for a page opened on its own, with no shell to ask. */
  readonly connected: boolean
  readonly newOpId: () => string
  /** Where an error thrown by page code's watcher goes. */
  readonly report: (error: unknown) => void
}): PageData => {
  const { bootstrap, requests } = deps
  const page = bootstrap.path
  const files = new Map<string, FileState>()
  const watchers = new Map<number, Watcher>()
  let nextSub = 1

  /** A page error with a fix and a path even when the answer names none. */
  const pageError = (fields: ErrorFields, input: string): DossierError => {
    const code = fields.code as PageErrorCode
    return new DossierError({
      ...fields,
      fix: fields.fix ?? FIXES[code] ?? null,
      path: fields.path ?? input,
    })
  }

  const fail = (
    code: PageErrorCode,
    message: string,
    input: string,
  ): DossierError => pageError({ code, message, fix: null, path: null }, input)

  const fieldsOf = (error: unknown): ErrorFields =>
    error instanceof DossierError
      ? {
          code: error.code,
          message: error.message,
          fix: error.fix,
          path: error.path,
        }
      : UNAVAILABLE

  /** A refused request as page code sees it: an error, or nothing. */
  const outcome = (error: unknown, op: PageOp, input: string) => {
    const result = toPageError(fieldsOf(error), op)
    return result.kind === 'error'
      ? { kind: 'error' as const, error: pageError(result.error, input) }
      : result
  }

  /** The tree path page code names, or the error it gets at once. */
  const target = (input: unknown, op: PageOp): string => {
    if (typeof input !== 'string') {
      throw fail('invalid', 'A path is a string.', String(input))
    }
    const email = deps.me()?.email ?? null
    const signedIn = op === 'write' || op === 'withdraw' || op === 'upload'
    if (email === null && (signedIn || input.includes('~'))) {
      throw fail(
        'sign_in_required',
        'Only a signed-in person can do this.',
        input,
      )
    }
    const path = resolvePath(page, input, email)
    if (path === null) {
      throw fail('forbidden', 'This path is not inside this tree.', input)
    }
    return path
  }

  /** Runs a call once identity is in place, or refuses it on its own page. */
  const gate = <T>(run: () => Promise<T>): Promise<T> => {
    if (!deps.connected) {
      return Promise.reject(
        fail('unavailable', 'This page is not open in Dossier.', ''),
      )
    }
    return deps.isReady() ? run() : deps.ready.then(run)
  }

  const call = (fn: () => void): void => {
    try {
      fn()
    } catch (error) {
      deps.report(error)
    }
  }

  // Files ----------------------------------------------------------------

  const stateOf = (path: string): FileState => {
    let state = files.get(path)
    if (state === undefined) {
      state = {
        confirmed: undefined,
        local: undefined,
        at: '',
        inflight: null,
        queue: [],
      }
      files.set(path, state)
    }
    return state
  }

  const pending = (state: FileState): boolean =>
    state.inflight !== null || state.queue.length > 0

  /** The stored value with the pending patches applied in order. */
  const recompute = (state: FileState): Json | undefined => {
    if (!pending(state)) return undefined
    let value: Json | undefined =
      state.confirmed === undefined
        ? undefined
        : ((state.confirmed?.data ?? null) as Json)
    for (const batch of [state.inflight, ...state.queue]) {
      if (batch === null) continue
      value = batch.replace
        ? batch.patch
        : applyMergePatch(value ?? {}, batch.patch)
    }
    return value
  }

  /** What page code sees of a file now. */
  const shown = (path: string): Doc | null => {
    const state = files.get(path)
    if (state === undefined) return null
    if (pending(state)) {
      return {
        path: relativeToPage(page, path),
        data: state.local ?? null,
        by: deps.me()?.email ?? state.confirmed?.by ?? '',
        at: state.at,
        push: bootstrap.push,
      }
    }
    return state.confirmed ? docFromWire(state.confirmed, page) : null
  }

  const confirm = (path: string, wire: DocWire | null): void => {
    const state = stateOf(path)
    state.confirmed = wire
    state.local = recompute(state)
  }

  /** A folder's files, from the stored list with pending writes shown. */
  const folderFiles = (
    folder: string,
    wires: readonly DocWire[],
  ): { readonly path: string; readonly doc: Doc }[] => {
    const out = new Map<string, Doc | null>()
    for (const wire of wires) {
      confirm(wire.path, wire)
      out.set(wire.path, shown(wire.path))
    }
    for (const [path, state] of files) {
      if (pending(state) && path.startsWith(folder)) out.set(path, shown(path))
    }
    return [...out]
      .filter((entry): entry is [string, Doc] => entry[1] !== null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, doc]) => ({ path, doc }))
  }

  /** Calls the watchers of a file, and of every folder above it. */
  const notify = (path: string): void => {
    const doc = shown(path)
    for (const watcher of watchers.values()) {
      if (watcher.path === path) {
        call(() => watcher.onChange(doc))
        continue
      }
      if (
        !isFolder(watcher.path) ||
        !path.startsWith(watcher.path) ||
        watcher.files === undefined
      ) {
        continue
      }
      const rest = watcher.files.filter((file) => file.path !== path)
      if (doc !== null) {
        rest.push({ path, doc })
        rest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      }
      watcher.files = rest
      const docs = rest.map((file) => file.doc)
      call(() => watcher.onChange(docs))
    }
  }

  // Writes ---------------------------------------------------------------

  const request = (path: string, batch: Batch): Promise<unknown> =>
    requests.request({
      op: 'write',
      path: `/${path}`,
      patch: batch.patch,
      replace: batch.replace,
      opId: deps.newOpId(),
      seq: bootstrap.seq,
    })

  /** Sends the file's next batch, if any and none is in flight. */
  const sendNext = (path: string): void => {
    const state = stateOf(path)
    if (state.inflight !== null) return
    const batch = state.queue.shift()
    if (batch === undefined) return
    state.inflight = batch
    request(path, batch).then(
      (value) => {
        const before = JSON.stringify(shown(path)?.data)
        state.inflight = null
        if (!isDocWire(value)) {
          state.local = recompute(state)
          for (const each of batch.calls) {
            each.reject(pageError(UNAVAILABLE, each.input))
          }
        } else {
          confirm(path, value)
          const doc = docFromWire(value, page)
          for (const each of batch.calls) each.resolve(doc)
        }
        if (JSON.stringify(shown(path)?.data) !== before) notify(path)
        sendNext(path)
      },
      (error: unknown) => {
        state.inflight = null
        // What is stored, with the patches still to go.
        state.local = recompute(state)
        for (const each of batch.calls) {
          const result = outcome(error, 'write', each.input)
          each.reject(
            result.kind === 'error'
              ? result.error
              : pageError(UNAVAILABLE, each.input),
          )
        }
        notify(path)
        sendNext(path)
      },
    )
  }

  /** A new entry in a folder: one request per call, never coalesced. */
  const writeEntry = (path: string, batch: Batch): void => {
    const [only] = batch.calls
    request(path, batch).then(
      (value) => {
        if (!isDocWire(value)) {
          only!.reject(pageError(UNAVAILABLE, only!.input))
          return
        }
        confirm(value.path, value)
        only!.resolve(docFromWire(value, page))
        notify(value.path)
      },
      (error: unknown) => {
        const result = outcome(error, 'write', only!.input)
        only!.reject(
          result.kind === 'error'
            ? result.error
            : pageError(UNAVAILABLE, only!.input),
        )
      },
    )
  }

  const write: PageData['write'] = (input, patch, opts) =>
    gate(
      () =>
        new Promise<Doc>((resolve, reject) => {
          const path = target(input, 'write')
          if (!isJsonObject(patch)) {
            throw fail('not_mergeable', 'A write takes a JSON object.', input)
          }
          const replace = opts?.replace === true
          const own: Call = { input, resolve, reject }
          if (isFolder(path)) {
            writeEntry(path, { patch, replace, calls: [own] })
            return
          }
          const state = stateOf(path)
          const current = pending(state)
            ? state.local
            : (state.confirmed?.data as Json | undefined)
          state.local = replace ? patch : applyMergePatch(current ?? {}, patch)
          state.at = new Date().toISOString()
          const last = state.queue.at(-1)
          if (replace) {
            // A replace starts the queue again from its value.
            const calls = state.queue.flatMap((batch) => batch.calls)
            state.queue = [{ patch, replace: true, calls: [...calls, own] }]
          } else if (last?.replace) {
            last.patch = applyMergePatch(last.patch, patch) as JsonObject
            last.calls.push(own)
          } else {
            const both =
              last === undefined ? null : composeMergePatch(last.patch, patch)
            if (last !== undefined && both !== null) {
              last.patch = both
              last.calls.push(own)
            } else {
              state.queue.push({ patch, replace: false, calls: [own] })
            }
          }
          notify(path)
          sendNext(path)
        }),
    )

  // Reads, withdrawals and uploads ---------------------------------------

  const read: PageData['read'] = (input) =>
    gate(async () => {
      const path = target(input, 'read')
      let value: unknown
      try {
        value = await requests.request({ op: 'read', path: `/${path}` })
      } catch (error) {
        const result = outcome(error, 'read', input)
        if (result.kind === 'error') throw result.error
        return isFolder(path) ? [] : null
      }
      if (isFolder(path)) {
        const wires = Array.isArray(value) ? value.filter(isDocWire) : []
        return folderFiles(path, wires).map((file) => file.doc)
      }
      confirm(path, isDocWire(value) ? value : null)
      return shown(path)
    })

  const withdraw: PageData['withdraw'] = (input) =>
    gate(async () => {
      const path = target(input, 'withdraw')
      try {
        await requests.request({
          op: 'withdraw',
          path: `/${path}`,
          opId: deps.newOpId(),
        })
      } catch (error) {
        const result = outcome(error, 'withdraw', input)
        if (result.kind === 'error') throw result.error
      }
      if (isFolder(path)) return
      confirm(path, null)
      notify(path)
    })

  const upload: PageData['upload'] = (file) =>
    gate(async () => {
      const named = (file as Partial<File> | null)?.name
      const name = typeof named === 'string' && named !== '' ? named : 'upload'
      if (deps.me() === null) {
        throw fail(
          'sign_in_required',
          'Only a signed-in person can do this.',
          name,
        )
      }
      if (!isBlob(file)) {
        throw fail('invalid', 'upload takes a File or a Blob.', name)
      }
      let value: unknown
      try {
        value = await requests.request({
          op: 'upload',
          file,
          name,
          contentType: file.type || 'application/octet-stream',
          opId: deps.newOpId(),
          seq: bootstrap.seq,
        })
      } catch (error) {
        const result = outcome(error, 'upload', name)
        throw result.kind === 'error'
          ? result.error
          : pageError(UNAVAILABLE, name)
      }
      if (
        !isJsonObject(value) ||
        typeof value.path !== 'string' ||
        typeof value.name !== 'string' ||
        typeof value.size !== 'number' ||
        typeof value.type !== 'string'
      ) {
        throw pageError(UNAVAILABLE, name)
      }
      return {
        file: relativeToPage(page, value.path),
        name: value.name,
        size: value.size,
        type: value.type,
      }
    })

  // Watching -------------------------------------------------------------

  const watch: PageData['watch'] = (input, onChange) => {
    let stopped = false
    let sub: number | null = null
    const start = (): void => {
      if (stopped) return
      let path: string
      try {
        path = target(input, 'watch')
      } catch {
        // Missing and refused look the same.
        const empty = typeof input === 'string' && input.endsWith('/')
        queueMicrotask(() => {
          if (!stopped) call(() => onChange(empty ? [] : null))
        })
        return
      }
      sub = nextSub++
      watchers.set(sub, { path, onChange, files: undefined })
      requests.request({ op: 'watch', sub, path: `/${path}` }).catch(() => {})
    }
    if (deps.connected) {
      if (deps.isReady()) start()
      else deps.ready.then(start, () => {})
    }
    return () => {
      if (stopped) return
      stopped = true
      if (sub === null) return
      watchers.delete(sub)
      requests.request({ op: 'unwatch', sub }).catch(() => {})
    }
  }

  const changed: PageData['changed'] = (message) => {
    const watcher = watchers.get(message.sub)
    if (watcher === undefined) return
    const { value } = message
    if (isFolder(watcher.path)) {
      const wires = Array.isArray(value) ? value.filter(isDocWire) : []
      watcher.files = folderFiles(watcher.path, wires)
      const docs = watcher.files.map((file) => file.doc)
      call(() => watcher.onChange(docs))
      return
    }
    confirm(watcher.path, isDocWire(value) ? value : null)
    const doc = shown(watcher.path)
    call(() => watcher.onChange(doc))
  }

  return { read, watch, write, withdraw, upload, changed }
}
