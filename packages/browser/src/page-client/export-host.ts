// The export host: in a page downloaded as one file, it answers the page
// client's requests in place of the shell, in the shell's own shapes, from
// the file's snapshot of the page's data and what this browser saved. It
// never reaches Dossier. What page code writes and forms send is kept in
// this browser's storage for the file, or for the tab when there is none.
import {
  DossierError,
  ERRORS,
  assembleThreads,
  commentsFolderIn,
  fromPageFolder,
  isCommentValue,
  pageOfCommentsFolder,
  pathsMeet,
  resolvePath,
  type CommentEntry,
  type CommentFile,
  type DocWire,
  type DraftValues,
  type ErrorCode,
  type ErrorFields,
  type ExportData,
  type Json,
  type JsonObject,
  type PageBootstrap,
  type PageToShell,
  type SendRequest,
  type SendValue,
  type ShellToPage,
} from '@dossier/contracts/bridge'
import type { HostPort } from './create-page-client.ts'
import { applyMergePatch, isJsonObject } from './merge-patch.ts'

/** The browser storage the export host keeps this browser's writes in. */
export interface ExportStorage {
  readonly getItem: Storage['getItem']
  readonly setItem: Storage['setItem']
  readonly removeItem: Storage['removeItem']
}

/** Before `<tree id>:<page path>`, the storage key of an exported page. */
export const EXPORT_STORAGE_PREFIX = 'dossier-export:'

/** A form's status line once a send is kept in this browser. */
export const EXPORT_SAVED_TEXT = 'Saved in this browser only.'

const NOT_IN_EXPORT = ERRORS.not_in_export.message

/** A file as this browser wrote it. */
interface SavedFile {
  readonly doc: DocWire
  /** When it was first written, ISO 8601. */
  readonly created: string
  /** Its versions: more than one once revised. */
  readonly revision: number
}

/** What this browser keeps for the page. */
interface Saved {
  /** Its files by tree path; null once withdrawn here. */
  readonly files: Map<string, SavedFile | null>
  /** Its forms' unsent values, by formKey. */
  readonly drafts: Map<string, DraftValues>
}

type Request = Extract<PageToShell, { type: 'request' }>

const bare = (path: string): string =>
  path.replace(/^\/+/, '').replace(/\/+$/, '')

const join = (...parts: readonly string[]): string =>
  parts.filter((part) => part !== '').join('/')

const isFolder = (path: string): boolean => path === '' || path.endsWith('/')

const refusal = (
  code: ErrorCode,
  message: string,
  path: string | null = null,
): DossierError => new DossierError({ code, message, fix: null, path })

const isText = (value: unknown): value is string => typeof value === 'string'

const isDocWire = (value: unknown): value is DocWire =>
  isJsonObject(value) &&
  isText(value.path) &&
  isText(value.by) &&
  isText(value.at) &&
  typeof value.push === 'number'

const isSavedFile = (value: unknown): value is SavedFile =>
  isJsonObject(value) &&
  isDocWire(value.doc) &&
  isText(value.created) &&
  typeof value.revision === 'number'

const isDraftValues = (value: unknown): value is DraftValues =>
  isJsonObject(value) &&
  Object.values(value).every(
    (v) => isText(v) || (Array.isArray(v) && v.every(isText)),
  )

const pairs = (value: unknown): readonly (readonly [unknown, unknown])[] =>
  Array.isArray(value)
    ? value.filter(
        (pair): pair is [unknown, unknown] =>
          Array.isArray(pair) && pair.length === 2,
      )
    : []

/** What storage held for the page, or nothing when it holds nothing usable. */
const parseSaved = (raw: string | null): Saved => {
  const saved: Saved = { files: new Map(), drafts: new Map() }
  if (raw === null) return saved
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return saved
  }
  if (!isJsonObject(value)) return saved
  for (const [path, file] of pairs(value.files)) {
    if (isText(path) && (file === null || isSavedFile(file))) {
      saved.files.set(path, file)
    }
  }
  for (const [form, values] of pairs(value.drafts)) {
    if (isText(form) && isDraftValues(values)) saved.drafts.set(form, values)
  }
  return saved
}

/** At most this many people one comment mentions, as Dossier allows. */
const MENTIONS_MAX = 20

const mentionsOf = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (!isText(item)) continue
    const email = item.trim().toLowerCase()
    if (email !== '' && !out.includes(email)) out.push(email)
  }
  return out.slice(0, MENTIONS_MAX)
}

const optionalText = (value: unknown): string | null =>
  isText(value) && value.trim() !== '' ? value.trim() : null

const textOf = (value: unknown): string => {
  const text = isText(value) ? value.trim() : ''
  if (text === '') {
    throw refusal('invalid', 'Write something to comment.', 'text')
  }
  return text
}

/**
 * A new comment, or a resolve or reopen, as Dossier would store it: `roots`
 * maps each comment of the folder, by its path from the page's folder, to
 * its thread's root.
 */
const commentEntryOf = (
  patch: JsonObject,
  folder: string,
  roots: ReadonlyMap<string, string>,
): JsonObject => {
  for (const mark of ['resolves', 'reopens'] as const) {
    if (!Object.hasOwn(patch, mark)) continue
    const root = patch[mark]
    if (
      Object.keys(patch).length !== 1 ||
      !isText(root) ||
      roots.get(root) !== root
    ) {
      throw refusal('invalid', `${String(root)} is not a thread in ${folder}/.`)
    }
    return { [mark]: root }
  }
  const text = textOf(patch.text)
  const anchor =
    isText(patch.anchor) && patch.anchor !== '' ? patch.anchor : null
  const pin = patch.pin
  let replyTo: string | null = null
  if (patch.replyTo !== undefined && patch.replyTo !== null) {
    const root = isText(patch.replyTo) ? roots.get(patch.replyTo) : undefined
    if (root === undefined) {
      throw refusal(
        'invalid',
        `${String(patch.replyTo)} is not a comment in ${folder}/.`,
        'replyTo',
      )
    }
    // A reply to a reply joins the thread's root.
    replyTo = root
  }
  const entry: CommentEntry = {
    text,
    anchor,
    label: optionalText(patch.label),
    pin:
      anchor !== null &&
      isJsonObject(pin) &&
      typeof pin.x === 'number' &&
      typeof pin.y === 'number'
        ? { x: pin.x, y: pin.y }
        : null,
    replyTo,
    stance: optionalText(patch.stance),
    mentions: mentionsOf(patch.mentions),
  }
  return entry as unknown as JsonObject
}

/**
 * A send's values: one value as it is, a repeated name as a list, and a
 * JSON field's text as its object, as Dossier stores it; empty text leaves
 * the field out.
 */
const valuesOf = (send: SendRequest): JsonObject => {
  const values = new Map<string, Json>()
  const valueOf = (value: SendValue): Json => {
    if (isText(value)) return value
    const info = { name: value.name, size: value.size, type: value.type }
    // An upload stored in Dossier before the export stays as it was; a file
    // chosen here stays on this device, and only what it was is kept.
    return 'file' in value && isText(value.file)
      ? { file: value.file, ...info }
      : info
  }
  for (const [name, value] of send.entries) {
    const before = values.get(name)
    const next = valueOf(value)
    values.set(
      name,
      before === undefined
        ? next
        : Array.isArray(before)
          ? [...before, next]
          : [before, next],
    )
  }
  if (send.submitter !== null) {
    values.set(send.submitter.name, send.submitter.value)
  }
  for (const name of send.json ?? []) {
    const text = values.get(name)
    if (!isText(text)) continue
    if (text.trim() === '') {
      values.delete(name)
      continue
    }
    let value: unknown = null
    try {
      value = JSON.parse(text)
    } catch {
      value = null
    }
    if (!isJsonObject(value)) {
      throw refusal('invalid', 'Use a JSON object for this field.', name)
    }
    values.set(name, value)
  }
  return Object.fromEntries(values)
}

/**
 * The answer a send merges into, without the fields it gives files: a file
 * field's value replaces what it held, so a file chosen here never keeps the
 * stored upload it replaces.
 */
const mergeBase = (send: SendRequest, existing: unknown): JsonObject => {
  if (!isJsonObject(existing)) return {}
  const base = { ...existing }
  for (const [name, value] of send.entries) {
    if (!isText(value)) delete base[name]
  }
  return base
}

/** The port the page client talks to, answered by the export host. */
class ExportPort extends EventTarget {
  #started = false
  #closed = false
  readonly #queue: ShellToPage[] = []
  readonly #onRequest: (message: PageToShell) => void

  constructor(onRequest: (message: PageToShell) => void) {
    super()
    this.#onRequest = onRequest
  }

  postMessage(message: unknown): void {
    if (this.#closed) return
    this.#onRequest(message as PageToShell)
  }

  /** Delivers to the page later, as a port would, once it has started. */
  tell(message: ShellToPage): void {
    if (this.#closed) return
    // The page gets its own copy, which page code may change freely.
    const copy = structuredClone(message)
    if (this.#started) this.#deliver(copy)
    else this.#queue.push(copy)
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    for (const message of this.#queue.splice(0)) this.#deliver(message)
  }

  close(): void {
    this.#closed = true
  }

  #deliver(message: ShellToPage): void {
    queueMicrotask(() => {
      if (!this.#closed) {
        this.dispatchEvent(new MessageEvent('message', { data: message }))
      }
    })
  }
}

export const createExportHost = (deps: {
  readonly data: ExportData
  readonly bootstrap: PageBootstrap
  /** Null: kept in memory for this tab. */
  readonly storage: ExportStorage | null
  readonly now: () => Date
}): HostPort => {
  const { data, bootstrap, now } = deps
  const page = bare(bootstrap.path)
  const key = `${EXPORT_STORAGE_PREFIX}${bootstrap.tree.id}:${page}`
  const me = data.me
  const email = me?.email.toLowerCase() ?? null

  // A storage the browser refuses, or that refuses a write, leaves what this
  // browser saved in memory for the tab.
  let storage = deps.storage
  let raw: string | null = null
  try {
    raw = storage?.getItem(key) ?? null
  } catch {
    storage = null
  }
  const saved = parseSaved(raw)
  const persist = (): void => {
    try {
      storage?.setItem(
        key,
        JSON.stringify({
          v: 1,
          files: [...saved.files],
          drafts: [...saved.drafts],
        }),
      )
    } catch {
      // Still kept for the tab.
    }
  }

  const snapshot = new Map<string, DocWire>()
  for (const file of data.files) snapshot.set(bare(file.path), file)
  const comments = new Map(Object.entries(data.comments))

  /** A file now: this browser's copy, else the snapshot's. */
  const current = (path: string): DocWire | null =>
    saved.files.has(path)
      ? (saved.files.get(path)?.doc ?? null)
      : (snapshot.get(path) ?? null)

  const pathsBelow = (folder: string): string[] =>
    [...new Set([...snapshot.keys(), ...saved.files.keys()])]
      .filter((path) => path.startsWith(folder))
      .sort()

  /** A comments folder's files, as the Worker's folder read gives them. */
  const commentFiles = (folder: string): CommentFile[] => {
    const name = fromPageFolder(folder)
    return pathsBelow(`${folder}/`).flatMap((path): CommentFile[] => {
      const doc = current(path)
      if (doc === null) return []
      const kept = saved.files.get(path)
      const known = comments.get(path)
      const at = Date.parse(kept?.created ?? known?.created ?? doc.at)
      return [
        {
          path: `${name}${path.slice(folder.length)}`,
          treePath: path,
          by: doc.by,
          // One written here is the exporter's own.
          name:
            known?.name ??
            (kept !== undefined && me !== null && doc.by === me.email
              ? me.name || null
              : null),
          at: Number.isNaN(at) ? 0 : at,
          push: doc.push,
          revision: kept?.revision ?? known?.revision ?? 1,
          value: doc.data,
        },
      ]
    })
  }

  /** A path's value as a read gives it. */
  const valueOf = (path: string): DocWire | readonly DocWire[] | null => {
    if (!isFolder(path)) return current(path)
    if (path !== '' && pageOfCommentsFolder(path) !== null) {
      return assembleThreads(commentFiles(bare(path)))
    }
    return pathsBelow(path).flatMap((file) => {
      const doc = current(file)
      return doc === null ? [] : [doc]
    })
  }

  // Changes --------------------------------------------------------------

  const watches = new Map<number, string>()
  /** Paths changed by the request being answered; watchers hear after. */
  const touched: string[] = []
  /** A watch just added, which hears the value now after its answer. */
  let added: number | null = null

  const docFor = (path: string, value: Json): DocWire => ({
    path,
    data: value,
    by: me?.email ?? '',
    at: now().toISOString(),
    push: bootstrap.push as DocWire['push'],
  })

  /** Keeps a file in this browser: its first time, and one more version. */
  const keep = (path: string, doc: DocWire): DocWire => {
    const before = saved.files.get(path)
    const original = before === undefined ? snapshot.get(path) : undefined
    const known = comments.get(path)
    saved.files.set(path, {
      doc,
      created:
        before?.created ??
        (original === undefined ? doc.at : (known?.created ?? original.at)),
      revision:
        before !== undefined && before !== null
          ? before.revision + 1
          : original === undefined
            ? 1
            : (known?.revision ?? 1) + 1,
    })
    persist()
    touched.push(path)
    return doc
  }

  const remove = (path: string): void => {
    saved.files.set(path, null)
    persist()
    touched.push(path)
  }

  // Rules ----------------------------------------------------------------

  const signedIn = (): string => {
    if (email === null) {
      throw refusal('sign_in_required', 'Only a signed-in person can do this.')
    }
    return email
  }

  const resolve = (input: string, code: 'not_found' | 'forbidden'): string => {
    // Dossier names a person's files by their email in lower case.
    const path = resolvePath(page, input, email)
    if (path !== null) return path
    throw refusal(
      code,
      code === 'forbidden'
        ? 'This path is not inside this tree.'
        : 'Not found.',
      input,
    )
  }

  /** Whether a path names the viewer's own file or folder, by its email. */
  const isOwn = (path: string): boolean =>
    bare(path)
      .split('/')
      .some(
        (segment) => segment.replace(/\.json$/i, '').toLowerCase() === email,
      )

  /** Page code never writes a `_` file, nor someone else's. */
  const mayWrite = (path: string): void => {
    const segments = bare(path).split('/')
    if (segments.some((segment) => segment.startsWith('_'))) {
      throw refusal('forbidden', 'Page code never writes a _ file.', path)
    }
    const last = segments.length - 1
    const stem = (segment: string, n: number) =>
      n === last && !isFolder(path) ? segment.replace(/\.json$/i, '') : segment
    if (
      segments.some(
        (segment, n) =>
          segment.includes('@') && stem(segment, n).toLowerCase() !== email,
      )
    ) {
      throw refusal('forbidden', "This is another person's file.", path)
    }
  }

  /** A new entry's path in `folder`, named for now like Dossier names it. */
  const newEntry = (folder: string): string => {
    const stamp = now().toISOString().slice(0, 19).replaceAll(':', '-')
    let path = join(folder, `${stamp}.json`)
    for (let n = 2; current(path) !== null; n += 1) {
      path = join(folder, `${stamp}-${n}.json`)
    }
    return path
  }

  /** A folder's own subfolder for the viewer, unless it is that already. */
  const ownFolderIn = (folder: string, own: string): string => {
    const name = folder.slice(folder.lastIndexOf('/') + 1)
    return name.toLowerCase() === own ? folder : join(folder, own)
  }

  // Requests -------------------------------------------------------------

  const writeComment = (
    folder: string,
    path: string,
    request: Extract<Request, { op: 'write' }>,
    own: string,
  ): DocWire => {
    if (request.replace) {
      throw refusal(
        'invalid',
        'A comment is revised, never replaced whole.',
        request.path,
      )
    }
    if (isFolder(path)) {
      const roots = new Map<string, string>()
      for (const file of commentFiles(folder)) {
        if (isCommentValue(file.value)) {
          roots.set(file.path, file.value.replyTo ?? file.path)
        }
      }
      const entry = commentEntryOf(request.patch, fromPageFolder(folder), roots)
      const at = newEntry(join(folder, own))
      return keep(at, docFor(at, entry))
    }
    const existing = current(path)
    if (existing === null || !isCommentValue(existing.data)) {
      throw refusal('forbidden', 'Only a comment is revised here.', path)
    }
    const other = Object.keys(request.patch).find(
      (name) => name !== 'text' && name !== 'mentions',
    )
    if (other !== undefined) {
      throw refusal(
        'invalid',
        `Only a comment's text and mentions change once it is written; ${other} stays.`,
        other,
      )
    }
    const revised: Record<string, unknown> = { ...existing.data }
    if (Object.hasOwn(request.patch, 'text')) {
      revised.text = textOf(request.patch.text)
    }
    if (Object.hasOwn(request.patch, 'mentions')) {
      revised.mentions = mentionsOf(request.patch.mentions)
    }
    return keep(path, docFor(path, revised as JsonObject))
  }

  const write = (request: Extract<Request, { op: 'write' }>): DocWire => {
    const own = signedIn()
    const path = resolve(request.path, 'forbidden')
    mayWrite(path)
    const patch = structuredClone(request.patch)
    const folder = commentsFolderIn(path)
    if (folder !== null) {
      return writeComment(folder, path, { ...request, patch }, own)
    }
    if (isFolder(path)) {
      const at = newEntry(ownFolderIn(bare(path), own))
      return keep(
        at,
        docFor(at, request.replace ? patch : applyMergePatch({}, patch)),
      )
    }
    const existing = current(path)?.data as Json | undefined
    if (
      !request.replace &&
      existing !== undefined &&
      existing !== null &&
      !isJsonObject(existing)
    ) {
      throw refusal(
        'not_mergeable',
        'This file does not hold a JSON object, so a patch cannot merge into it.',
        path,
      )
    }
    return keep(
      path,
      docFor(
        path,
        request.replace ? patch : applyMergePatch(existing ?? {}, patch),
      ),
    )
  }

  const send = (request: SendRequest): unknown => {
    if (email === null) {
      throw refusal('not_in_export', 'Only a signed-in person can send this.')
    }
    const info = bootstrap.forms.find(
      (form) =>
        form.host === request.form.host &&
        form.target === request.form.target &&
        form.id === request.form.id,
    )
    if (info === undefined) {
      throw refusal('invalid', 'This form is not on this page.')
    }
    const closesAt = info.closesAt === null ? NaN : Date.parse(info.closesAt)
    if (info.closed || closesAt <= now().getTime()) {
      // The form shows when it closed.
      throw refusal('closed', '')
    }
    const values = valuesOf(request)
    const target = bare(info.target)
    let doc: DocWire
    // Each merges as Dossier's send does: into the answer before it, or
    // into nothing, a JSON field's nulls gone at every depth.
    if (info.kind === 'person') {
      const path = join(target, `${email}.json`)
      const existing = current(path)?.data
      doc = keep(
        path,
        docFor(path, applyMergePatch(mergeBase(request, existing), values)),
      )
    } else if (info.kind === 'entries') {
      const path = newEntry(join(target, email))
      doc = keep(path, docFor(path, applyMergePatch({}, values)))
    } else {
      const existing = current(target)?.data
      doc = keep(
        target,
        docFor(target, applyMergePatch(mergeBase(request, existing), values)),
      )
    }
    return { doc, replayed: false }
  }

  const withdraw = (input: string): null => {
    signedIn()
    const path = resolve(input, 'not_found')
    const existing = current(path)
    if (existing === null || isFolder(path)) {
      throw refusal('not_found', 'Not found.', input)
    }
    if (!isOwn(path)) {
      throw refusal(
        'forbidden',
        'A shared file belongs to nobody, so it cannot be withdrawn.',
        path,
      )
    }
    if (commentsFolderIn(path) !== null && isCommentValue(existing.data)) {
      // A comment stays in its thread with its text gone.
      if (existing.data.text !== '') {
        const blank = { ...existing.data, text: '', mentions: [] }
        keep(path, docFor(path, blank as unknown as JsonObject))
      }
      return null
    }
    remove(path)
    return null
  }

  const answer = (request: Request): unknown => {
    switch (request.op) {
      case 'read':
        return valueOf(resolve(request.path, 'not_found'))
      case 'write':
        return write(request)
      case 'send':
        return send(request.send)
      case 'withdraw':
        return withdraw(request.path)
      case 'watch': {
        const path = resolve(request.path, 'forbidden')
        watches.set(request.sub, path)
        added = request.sub
        return null
      }
      case 'unwatch':
        watches.delete(request.sub)
        return null
      case 'mentionable':
        // Nobody is suggested away from Dossier but those in the threads.
        return { people: [], teams: [] }
      default:
        // Uploads, and anything else that needs Dossier.
        throw refusal('not_in_export', NOT_IN_EXPORT)
    }
  }

  const port = new ExportPort((message) => {
    if (message.type === 'draft') {
      if (message.values === null) saved.drafts.delete(message.form)
      else saved.drafts.set(message.form, message.values)
      persist()
      return
    }
    // Locations and navigation have no shell to go to.
    if (message.type !== 'request') return
    try {
      port.tell({
        type: 'result',
        id: message.id,
        ok: true,
        value: answer(message),
      })
    } catch (error) {
      const fields: ErrorFields =
        error instanceof DossierError
          ? {
              code: error.code,
              message: error.message,
              fix: error.fix,
              path: error.path,
            }
          : {
              code: 'unavailable',
              message: ERRORS.unavailable.message,
              fix: null,
              path: null,
            }
      port.tell({ type: 'result', id: message.id, ok: false, error: fields })
    }
    // Watchers hear of each change after the answer that made it, and a
    // new watch of the value now.
    const paths = touched.splice(0)
    for (const [sub, watched] of watches) {
      if (sub === added || paths.some((path) => pathsMeet(watched, path))) {
        port.tell({ type: 'changed', sub, value: valueOf(watched) })
      }
    }
    added = null
  })

  port.tell({
    type: 'welcome',
    v: 1,
    me,
    drafts: Object.fromEntries(saved.drafts),
    resume: [],
  })
  return port
}
