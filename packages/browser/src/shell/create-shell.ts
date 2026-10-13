import {
  BRIDGE_VERSION,
  DossierError,
  ERRORS,
  VISITOR_VIEWER,
  WINDOW_NAME_PREFIX,
  formKey,
  isHello,
  isPageToShell,
  resolvePath,
  type DocWire,
  type DraftValues,
  type ErrorCode,
  type ErrorFields,
  type FormRef,
  type JsonObject,
  type Me,
  type PageToShell,
  type PendingSend,
  type RoleName,
  type SendRequest,
  type ShellBoot,
  type ShellToPage,
  type TopBoot,
  type UploadRef,
} from '@dossier/contracts/bridge'
import type { ChangeSource } from './changes.ts'
import { within } from './frames.ts'
import type { ShellStore } from './store.ts'
import { createWatches } from './watch.ts'

export interface ViewGrant {
  readonly handle: string
  readonly expiresAt: string
  readonly seq: number
  readonly role: RoleName
  /** The tree path of the page or file the frame opens. */
  readonly path: string
  /** Whom the grant is for; null for a visitor. */
  readonly email: string | null
  /**
   * The events cursor as of the grant, the shell's first `after`. Opaque:
   * the shell only hands it back.
   */
  readonly events: string
}

/** The body of a send, as the API takes it. */
export interface SendPayloadWire {
  readonly tree: string
  /** The page's tree path: 'questions/index.html'. */
  readonly page: string
  readonly seq: number
  readonly form: FormRef
  readonly entries: readonly (readonly [string, string | UploadRef])[]
  readonly submitter: SendRequest['submitter']
  readonly entry: string | null
  readonly opId: string
  /** Whom the page was shown to: the deployment refuses anyone else. */
  readonly as: string | null
}

/** doc null: the answer was withdrawn since. */
export interface SendResultWire {
  readonly doc: DocWire | null
  readonly replayed: boolean
}

/**
 * The query of an upload, as the API takes it. A form's file names its form
 * and field; page code's upload has neither and is stored beside the page.
 */
export interface UploadParamsWire {
  readonly tree: string
  readonly page: string
  readonly seq: number
  readonly host?: string
  readonly target?: string
  readonly id?: string | null
  /** The file field's name. */
  readonly field?: string
  readonly name: string
  readonly type: string
  readonly size: number
  readonly sha256: string
  readonly opId: string
  readonly as: string | null
}

export interface UploadResultWire extends UploadRef {
  /** The tree path of the stored file. */
  readonly path: string
}

/** Page code's write, as the API takes it. */
export interface WritePayloadWire {
  readonly tree: string
  /** The page's tree path: 'board.html'. */
  readonly page: string
  /** A tree path, resolved by the shell: 'layout.json', 'ideas/<email>/'. */
  readonly path: string
  readonly patch: JsonObject
  readonly replace: boolean
  readonly opId: string
  /** The page's bootstrap sequence. */
  readonly seq: number
  /** Whom the page was shown to: the deployment refuses anyone else. */
  readonly as: string | null
}

/** One event the caller may read. */
export interface EventWire {
  /** Opaque: the cursor that resumes after this event. */
  readonly cursor: string
  readonly type: string
  /** Inside the tree. */
  readonly path: string
  /** ISO 8601. */
  readonly at: string
  readonly by: string | null
  readonly push: number | null
}

export interface EventsResponseWire {
  readonly events: readonly EventWire[]
  /** Opaque: the `after` of the next request. */
  readonly next: string
  /** More events follow `next`. */
  readonly more: boolean
}

/** Every call rejects with a DossierError; offline when nothing answered. */
export interface ShellApi {
  readonly view: (i: {
    readonly tree: string
    readonly path: string
    /** The shell renewing the open page's handle: not a new view. */
    readonly renewal?: boolean
  }) => Promise<ViewGrant>
  /**
   * The page a nested page says it is, as the deployment answers for this
   * session: its canonical tree path and the person it answers as. Rejects
   * when the page is missing or the person may not open it.
   */
  readonly confirm: (i: {
    readonly tree: string
    readonly page: string
  }) => Promise<{ readonly path: string; readonly email: string | null }>
  /** A file, null when it is missing or unreadable, or a folder's files. */
  readonly read: (i: {
    readonly tree: string
    readonly path: string
  }) => Promise<DocWire | DocWire[] | null>
  readonly send: (payload: SendPayloadWire) => Promise<SendResultWire>
  readonly upload: (
    i: UploadParamsWire & { readonly body: Blob },
  ) => Promise<UploadResultWire>
  readonly withdraw: (i: {
    readonly tree: string
    readonly path: string
    readonly opId: string
    readonly as: string | null
  }) => Promise<void>
  readonly write: (payload: WritePayloadWire) => Promise<DocWire>
  /** The events after `after` that the caller may read. */
  readonly events: (i: {
    readonly tree: string
    /** A cursor a view or this route gave, handed back as it came. */
    readonly after: string
  }) => Promise<EventsResponseWire>
}

export interface ShellDeps {
  readonly window: Window
  readonly frame: HTMLIFrameElement
  readonly boot: ShellBoot
  readonly api: ShellApi
  readonly store: ShellStore
  readonly changes: ChangeSource
}

const HOUR = 60 * 60 * 1000
/** How long the shell waits before reloading after an error that is not a refusal. */
export const RETRY_DELAY = 5000
/** How often the shell tries the sends it keeps while the tab is open. */
export const REPLAY_INTERVAL = 30_000
/**
 * The waits before uploading again when the deployment is cleaning up the
 * same bytes: a purge finishes in moments, so a few short tries suffice.
 */
export const RECLAIM_DELAYS: readonly number[] = [500, 2000, 5000]
/** The waits before page code's request is tried again without an answer. */
export const NO_ANSWER_WAITS: readonly number[] = [1000, 3000, 9000]

const FRAME_ATTRIBUTES: Readonly<Record<string, string>> = {
  id: 'dossier-page',
  sandbox: [
    'allow-scripts',
    'allow-same-origin',
    'allow-forms',
    'allow-popups',
    'allow-popups-to-escape-sandbox',
    'allow-modals',
    'allow-downloads',
    'allow-presentation',
    'allow-top-navigation-by-user-activation',
  ].join(' '),
  allow: 'fullscreen; clipboard-write; autoplay; picture-in-picture',
}

/** Answers after which the link route, on reload, shows sign-in or no access. */
const REFUSALS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'not_found',
  'sign_in_required',
])

/** What the page frame is called: the page's title, else its link's path. */
const frameTitleFor =
  (boot: ShellBoot) =>
  (title: string, path: string): string =>
    title.trim() === ''
      ? `${boot.tree.workspace}/${boot.tree.name}/${treePath(path)}`
      : title

const hashOf = (hash: string): string =>
  hash === '' || hash.startsWith('#') ? hash : ''

type Request = Extract<PageToShell, { type: 'request' }>

const treePath = (path: string): string => path.replace(/^\/+/, '')

/** Values as one JSON text whatever their keys' order. */
const canonical = (values: Readonly<Record<string, unknown>>): string =>
  JSON.stringify(
    Object.keys(values)
      .sort()
      .map((key) => [key, values[key]]),
  )

/** A File or Blob value of a send, as opposed to text or a stored upload. */
const isFile = (value: unknown): value is File =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Partial<Blob>).arrayBuffer === 'function' &&
  typeof (value as Partial<File>).name === 'string'

const fieldsOf = (error: unknown): ErrorFields =>
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

const codeOf = (error: unknown): ErrorCode | null =>
  error instanceof DossierError ? error.code : null

const offlineError = (): DossierError =>
  new DossierError({
    code: 'offline',
    message: ERRORS.offline.message,
    fix: null,
    path: null,
  })

const unavailableError = (): DossierError =>
  new DossierError({
    code: 'unavailable',
    message: ERRORS.unavailable.message,
    fix: null,
    path: null,
  })

/** The answer to a path that leaves the tree, or names `~` for a visitor. */
const unresolved = (
  code: 'not_found' | 'forbidden' | 'sign_in_required',
  path: string,
): DossierError =>
  new DossierError({
    code,
    message:
      code === 'sign_in_required'
        ? 'Sign in first.'
        : code === 'forbidden'
          ? 'This path is not inside this tree.'
          : 'Not found.',
    fix: null,
    path,
  })

const isWebUrl = (href: string): boolean => {
  try {
    const { protocol } = new URL(href)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * The shell: frames the page from the tree's content origin, accepts the
 * page client's hello, keeps the address bar in step with the page, renews
 * the view handle, and carries the pages' reads and sends to the API, keeping
 * drafts and unanswered sends on this device.
 */
export const createShell = (
  deps: ShellDeps,
): { readonly start: () => Promise<void>; readonly dispose: () => void } => {
  const { window: win, boot, api, store } = deps
  const doc = win.document
  const treePrefix = `/${encodeURIComponent(boot.tree.workspace)}/${encodeURIComponent(boot.tree.name)}/`
  const frameTitle = frameTitleFor(boot)

  let frame = deps.frame
  /** The newest grant's handle, for the next load and hello checks. */
  let handle: string | null = null
  /** The handle the page in the frame now was loaded with. */
  let framedHandle: string | null = null
  let role: RoleName = 'read'
  /** The link path of the page shown now. */
  let linkPath = boot.linkPath
  /** The tree path the grant of the page in the frame named. */
  let framedPath: string | null = null
  let renewedAt = 0
  let loads = 0
  /** The navigation whose page the frame shows now. */
  let shown = 0
  let disposed = false
  let renewTimer: number | undefined
  let retryTimer: number | undefined
  let replayTimer: number | undefined
  /**
   * Every port of the page in the frame now, with its page's tree path. The
   * shell follows navigation only from the top page's port; every accepted
   * page may read, send and keep drafts.
   */
  const ports = new Map<MessagePort, string>()
  /** The pages whose kept sends are being tried now. */
  const replaying = new Set<string>()
  /** The visitor's drafts and kept sends becoming the person's, once. */
  let claimed: Promise<void> | null = null

  const me = (): Me | null => (boot.me === null ? null : { ...boot.me, role })
  /** Whose drafts these are: the person's email, or the visitor's key. */
  const viewer = (): string => boot.me?.email ?? VISITOR_VIEWER
  /** Whom this shell's pages were shown to; every send says so. */
  const shownTo = (): string | null => boot.me?.email ?? null
  /**
   * The deployment answers for the person this shell booted for. Someone
   * else signed in meanwhile (or no one is): nothing of this person's goes
   * on, and a reload shows the page as it is for whoever is there now.
   */
  const samePerson = (email: string | null): boolean =>
    (email ?? '').toLowerCase() === (shownTo() ?? '').toLowerCase()
  const tree = boot.tree.id

  /**
   * The port of the page each nested frame holds now, by the frame's window,
   * which stays the same object when the frame navigates.
   */
  let nestedPorts = new WeakMap<object, MessagePort>()

  const closePorts = (): void => {
    for (const port of ports.keys()) {
      watches.drop(port)
      port.close()
    }
    ports.clear()
    nestedPorts = new WeakMap()
  }

  /** A page is gone: its port closes and its watches go. */
  const release = (port: MessagePort): void => {
    watches.drop(port)
    ports.delete(port)
    port.close()
  }

  /** The tree path a send was stored at, for the watches' read fence. */
  const sentPath = (send: SendRequest, result: SendResultWire): string =>
    result.doc?.path ?? send.form.target

  /** The store answers, or nothing: a store that fails keeps nothing. */
  const quietly = async <T>(
    work: () => Promise<T>,
    fallback: T,
  ): Promise<T> => {
    try {
      return await work()
    } catch {
      return fallback
    }
  }

  /**
   * Back from sign-in, what the visitor kept in this tree on this device
   * becomes the person's: their drafts (the person's own stay) and kept
   * sends, which then go as the person. Every read of drafts or kept sends
   * waits for it, so a claimed send is tried once, as the person.
   */
  const claim = (): Promise<void> => {
    const person = boot.me
    if (person === null) return Promise.resolve()
    claimed ??= quietly(() => store.claimVisitor(person.email, tree), undefined)
    return claimed
  }

  /**
   * The kept sends of a page this viewer may send: their own, the visitor's
   * having become a signed-in person's by then, or a visitor's kept since.
   * Another person's are dropped; their draft stays theirs.
   */
  const pendingFor = async (page: string): Promise<PendingSend[]> => {
    await claim()
    const all = await quietly(() => store.loadPending(tree, page), [])
    const email = boot.me?.email ?? null
    const mine: PendingSend[] = []
    for (const send of all) {
      if (send.by === null || send.by === email) mine.push(send)
      else
        await quietly(
          () => store.clearPending(tree, page, send.opId),
          undefined,
        )
    }
    return mine
  }

  const pageState = async (
    page: string,
  ): Promise<{
    readonly drafts: Readonly<Record<string, DraftValues>>
    readonly resume: readonly string[]
  }> => {
    await claim()
    const drafts = await quietly(
      () => store.loadDrafts(viewer(), tree, page),
      {},
    )
    const pending = await pendingFor(page)
    return {
      drafts,
      resume: [...new Set(pending.map((send) => formKey(send.form)))],
    }
  }

  const post = (port: MessagePort, message: ShellToPage): void => {
    // A MessagePort's postMessage takes no target origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    port.postMessage(message)
  }

  /** Every page's watches, on one connection for the tree. */
  const watches = createWatches({
    window: win,
    tree,
    api,
    changes: deps.changes,
    post,
  })

  const answer = (
    port: MessagePort,
    id: number,
    outcome: { readonly value: unknown } | { readonly error: unknown },
  ): void => {
    if ('value' in outcome) {
      post(port, { type: 'result', id, ok: true, value: outcome.value })
    } else {
      post(port, {
        type: 'result',
        id,
        ok: false,
        error: fieldsOf(outcome.error),
      })
    }
  }

  /** The link of the page shown now, on the main host. */
  const signIn = (): void => {
    const link = new URL(treePrefix + linkPath, boot.deployment.origin).href
    win.location.assign(`/_/sign-in?next=${encodeURIComponent(link)}`)
  }

  const sha256 = async (file: Blob): Promise<string> => {
    const digest = await win.crypto.subtle.digest(
      'SHA-256',
      await file.arrayBuffer(),
    )
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  }

  /** An upload, tried again while a purge holds its bytes. */
  const uploadKept = async (
    params: UploadParamsWire & { readonly body: Blob },
  ): Promise<UploadResultWire> => {
    for (let tried = 0; ; tried += 1) {
      try {
        return await api.upload(params)
      } catch (error) {
        const wait = RECLAIM_DELAYS[tried]
        if (codeOf(error) !== 'blob_reclaiming' || wait === undefined) {
          throw error
        }
        await new Promise((resolve) => win.setTimeout(resolve, wait))
      }
    }
  }

  /**
   * The sends of one form go one after another, kept ones and live ones
   * alike, so a newer answer always lands after an older one.
   */
  const lanes = new Map<string, Promise<unknown>>()
  const inLane = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const before = lanes.get(key) ?? Promise.resolve()
    const run = before.then(work, work)
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    lanes.set(key, settled)
    void settled.then(() => {
      if (lanes.get(key) === settled) lanes.delete(key)
    })
    return run
  }

  /** Uploads the send's files, then sends it with the stored uploads. */
  const deliver = (
    page: string,
    send: SendRequest,
    as: string | null,
  ): Promise<SendResultWire> =>
    inLane(`${page}|${formKey(send.form)}`, () => deliverNow(page, send, as))

  const deliverNow = async (
    page: string,
    send: SendRequest,
    as: string | null,
  ): Promise<SendResultWire> => {
    const entries: (readonly [string, string | UploadRef])[] = []
    /** How many files of each field are uploaded so far, for their op IDs. */
    const files = new Map<string, number>()
    for (const [field, value] of send.entries) {
      if (!isFile(value)) {
        entries.push([field, value])
        continue
      }
      const index = files.get(field) ?? 0
      files.set(field, index + 1)
      const stored = await uploadKept({
        tree,
        page,
        seq: send.seq,
        host: send.form.host,
        target: send.form.target,
        id: send.form.id,
        field,
        name: value.name,
        type: value.type || 'application/octet-stream',
        size: value.size,
        sha256: await sha256(value),
        opId: `${send.opId}:${field}:${index}`,
        as,
        body: value,
      })
      entries.push([
        field,
        {
          file: stored.file,
          name: stored.name,
          size: stored.size,
          type: stored.type,
        },
      ])
    }
    return api.send({
      tree,
      page,
      seq: send.seq,
      form: send.form,
      entries,
      submitter: send.submitter,
      entry: null,
      opId: send.opId,
      as,
    })
  }

  /** A send's text values as a draft holds them. */
  const draftOf = (send: SendRequest): DraftValues => {
    const out: Record<string, string | string[]> = {}
    for (const [name, value] of send.entries) {
      if (typeof value !== 'string') continue
      const before = out[name]
      out[name] =
        before === undefined
          ? value
          : Array.isArray(before)
            ? [...before, value]
            : [before, value]
    }
    return out
  }

  /** A send's text values as a draft holds them, to tell whether they match. */
  const asDraft = (send: SendRequest): string => canonical(draftOf(send))

  /**
   * After a kept send succeeds with no page to ask: the form's draft goes
   * only when it still holds what was sent, so later edits stay.
   */
  const replayed = async (page: string, send: PendingSend): Promise<void> => {
    const key = formKey(send.form)
    const owner = send.by ?? viewer()
    const drafts = await quietly(
      () => store.loadDrafts(owner, tree, page),
      {} as Readonly<Record<string, DraftValues>>,
    )
    const draft = drafts[key]
    if (draft !== undefined && canonical(draft) === asDraft(send)) {
      await quietly(
        () => store.saveDraft(owner, tree, page, key, null),
        undefined,
      )
    }
    await sent(page, send.form)
  }

  /**
   * After a send of a form succeeds, every kept send of it goes. Its draft
   * is the page's to clear: only the page knows of edits since the send.
   */
  const sent = async (page: string, form: FormRef) => {
    const key = formKey(form)
    const kept = await quietly(() => store.loadPending(tree, page), [])
    for (const send of kept) {
      if (formKey(send.form) === key) {
        await quietly(
          () => store.clearPending(tree, page, send.opId),
          undefined,
        )
      }
    }
  }

  const keep = (page: string, send: SendRequest): Promise<void> => {
    const pending: PendingSend = {
      ...send,
      page,
      by: boot.me?.email ?? null,
      savedAt: new Date().toISOString(),
    }
    return quietly(() => store.savePending(tree, page, pending), undefined)
  }

  const onSend = async (
    port: MessagePort,
    page: string,
    id: number,
    send: SendRequest,
  ): Promise<void> => {
    if (win.navigator.onLine === false) {
      await keep(page, send)
      answer(port, id, { error: offlineError() })
      return
    }
    try {
      const result = await deliver(page, send, shownTo())
      watches.acknowledged(sentPath(send, result))
      await sent(page, send.form)
      answer(port, id, { value: result })
    } catch (error) {
      const code = codeOf(error)
      if (code === 'sign_in_required') {
        // The page's form stays sending: the send goes on after sign-in.
        await keep(page, send)
        if (!disposed) signIn()
        return
      }
      if (code === 'offline') await keep(page, send)
      answer(port, id, { error })
    }
  }

  const tell = (page: string, notice: ShellToPage): void => {
    for (const [port, path] of ports) if (path === page) post(port, notice)
  }

  /** Tries a page's kept sends again, with their op IDs, and tells its pages. */
  const replay = async (page: string): Promise<void> => {
    if (replaying.has(page) || disposed) return
    replaying.add(page)
    try {
      for (const send of await pendingFor(page)) {
        const form = formKey(send.form)
        try {
          const value = await deliver(page, send, send.by)
          watches.acknowledged(sentPath(send, value))
          await replayed(page, send)
          tell(page, {
            type: 'resumed',
            form,
            ok: true,
            value,
            sent: draftOf(send),
            op: send.opId,
          })
        } catch (error) {
          if (codeOf(error) === 'sign_in_required') {
            // Its person is not the one signed in now, or no one is: the
            // send stays kept, and a reload asks whoever is here.
            if (!disposed) win.location.reload()
            return
          }
          tell(page, {
            type: 'resumed',
            form,
            ok: false,
            error: fieldsOf(error),
            op: send.opId,
          })
          // Still no answer: the rest waits for the next try.
          if (codeOf(error) === 'offline') return
          // Any answer ends the kept send.
          await quietly(
            () => store.clearPending(tree, page, send.opId),
            undefined,
          )
        }
      }
    } finally {
      replaying.delete(page)
    }
  }

  const replayOpen = (): void => {
    if (win.navigator.onLine === false) return
    for (const page of new Set(ports.values())) void replay(page)
  }

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      win.setTimeout(resolve, ms)
    })

  /**
   * Page code's request: offline only when the browser says so; the same
   * request, op ID and all, again after an answer that never came or while a
   * purge holds its blob; then unavailable. Any other answer is passed on.
   */
  const pageCall = async <T>(work: () => Promise<T>): Promise<T> => {
    if (win.navigator.onLine === false) throw offlineError()
    let lost = 0
    let reclaiming = 0
    for (;;) {
      try {
        return await work()
      } catch (error) {
        const code = codeOf(error)
        // The API answers offline only when the request got no answer.
        const noAnswer = code === 'offline'
        if (!noAnswer && code !== 'blob_reclaiming') throw error
        const waits = noAnswer ? NO_ANSWER_WAITS : RECLAIM_DELAYS
        const tries = noAnswer ? lost++ : reclaiming++
        const wait = waits[tries]
        if (wait === undefined || disposed) throw unavailableError()
        await sleep(wait)
        if (disposed) throw unavailableError()
      }
    }
  }

  const reply = (
    port: MessagePort,
    id: number,
    work: Promise<unknown>,
  ): void => {
    work.then(
      (value) => answer(port, id, { value }),
      (error: unknown) => answer(port, id, { error }),
    )
  }

  const onRequest = (
    port: MessagePort,
    page: string,
    request: Request,
  ): void => {
    const email = boot.me?.email ?? null
    /** The tree path, or the answer for one that leaves the tree. */
    const resolve = (
      path: string,
      missing: 'not_found' | 'forbidden',
    ): string | null => {
      const resolved = resolvePath(page, path, email)
      if (resolved !== null) return resolved
      const code =
        email === null && path.includes('~') && missing === 'forbidden'
          ? 'sign_in_required'
          : missing
      answer(port, request.id, { error: unresolved(code, path) })
      return null
    }
    switch (request.op) {
      case 'read': {
        const path = resolve(request.path, 'not_found')
        if (path === null) return
        reply(
          port,
          request.id,
          pageCall(() => api.read({ tree, path })),
        )
        return
      }
      case 'withdraw': {
        const path = resolve(request.path, 'not_found')
        if (path === null) return
        reply(
          port,
          request.id,
          pageCall(() =>
            api.withdraw({ tree, path, opId: request.opId, as: shownTo() }),
          ).then(() => {
            watches.acknowledged(path)
            return null
          }),
        )
        return
      }
      case 'write': {
        const path = resolve(request.path, 'forbidden')
        if (path === null) return
        reply(
          port,
          request.id,
          pageCall(() =>
            api.write({
              tree,
              page,
              path,
              patch: request.patch,
              replace: request.replace,
              opId: request.opId,
              seq: request.seq,
              as: shownTo(),
            }),
          ).then((stored) => {
            watches.acknowledged(stored.path)
            return stored
          }),
        )
        return
      }
      case 'upload': {
        const { file } = request
        let digest: string | null = null
        reply(
          port,
          request.id,
          pageCall(async () => {
            digest ??= await sha256(file)
            return api.upload({
              tree,
              page,
              seq: request.seq,
              name: request.name,
              type: request.contentType || 'application/octet-stream',
              size: file.size,
              sha256: digest,
              opId: request.opId,
              as: shownTo(),
              body: file,
            })
          }).then((stored) => {
            watches.acknowledged(stored.path)
            return stored
          }),
        )
        return
      }
      case 'watch': {
        const path = resolve(request.path, 'forbidden')
        if (path === null) return
        watches.add({ port, sub: request.sub, path })
        answer(port, request.id, { value: null })
        return
      }
      case 'unwatch':
        watches.remove(port, request.sub)
        answer(port, request.id, { value: null })
        return
      case 'send':
        void onSend(port, page, request.id, request.send)
        return
    }
  }

  const setUrl = (kind: 'push' | 'replace', url: string): void => {
    try {
      if (kind === 'push') win.history.pushState(null, '', url)
      else win.history.replaceState(null, '', url)
    } catch {
      // A URL the history refuses leaves the address bar as it is.
    }
  }

  const failed = (error: unknown): void => {
    if (disposed) return
    if (error instanceof DossierError && REFUSALS.has(error.code)) {
      win.location.reload()
      return
    }
    win.clearTimeout(retryTimer)
    retryTimer = win.setTimeout(() => win.location.reload(), RETRY_DELAY)
  }

  const load = async (path: string, hash: string): Promise<void> => {
    // A new navigation: the page in the frame no longer moves the address,
    // and a reload planned for an earlier failure is off.
    const current = ++loads
    win.clearTimeout(retryTimer)
    let grant: ViewGrant
    try {
      grant = await api.view({ tree: boot.tree.id, path })
    } catch (error) {
      if (current === loads) failed(error)
      return
    }
    if (current !== loads || disposed) return
    if (!samePerson(grant.email)) {
      win.location.reload()
      return
    }
    const state = await pageState(treePath(grant.path))
    if (current !== loads || disposed) return
    win.clearTimeout(retryTimer)
    watches.seen(grant.events)
    shown = current
    handle = grant.handle
    framedHandle = grant.handle
    role = grant.role
    renewedAt = Date.now()
    linkPath = path
    framedPath = treePath(grant.path)

    // The sandbox comes from FRAME_ATTRIBUTES just below.
    // oxlint-disable-next-line react/iframe-missing-sandbox
    const next = doc.createElement('iframe')
    for (const [name, value] of Object.entries(FRAME_ATTRIBUTES)) {
      next.setAttribute(name, value)
    }
    // Until the page says its title, assistive technology names the frame
    // by the link's path.
    next.title = frameTitle('', path)
    const topBoot: TopBoot = {
      v: BRIDGE_VERSION,
      me: me(),
      drafts: state.drafts,
      resume: state.resume,
    }
    next.name = WINDOW_NAME_PREFIX + JSON.stringify(topBoot)
    next.src = `${boot.contentOrigin}/_/v/${grant.handle}/${grant.seq}/${path}${hashOf(hash)}`
    closePorts()
    frame.replaceWith(next)
    frame = next
  }

  const renew = async (): Promise<void> => {
    const current = loads
    try {
      const grant = await api.view({
        tree: boot.tree.id,
        path: linkPath,
        renewal: true,
      })
      // A load since then holds a fresher grant.
      if (disposed || current !== loads) return
      if (!samePerson(grant.email)) {
        win.location.reload()
        return
      }
      handle = grant.handle
      role = grant.role
      renewedAt = Date.now()
    } catch {
      // The page stays; the next renewal or load asks again.
    }
  }

  const onPageMessage = (
    data: unknown,
    port: MessagePort,
    page: string,
    navigation: number | null,
  ): void => {
    if (!isPageToShell(data)) return
    if (data.type === 'request') {
      onRequest(port, page, data)
      return
    }
    if (data.type === 'draft') {
      void quietly(
        () => store.saveDraft(viewer(), tree, page, data.form, data.values),
        undefined,
      )
      return
    }
    // Only the top page moves the address bar and opens other pages.
    if (navigation === null) return
    switch (data.type) {
      case 'location':
        // Only the page of the navigation in progress, if any, has the
        // address: an older page reporting late would overwrite it.
        if (navigation !== loads) return
        linkPath = data.path
        setUrl('replace', treePrefix + data.path + hashOf(data.hash))
        doc.title = data.title || boot.deployment.name
        frame.title = frameTitle(data.title, data.path)
        return
      case 'open':
        setUrl('push', treePrefix + data.path + hashOf(data.hash))
        void load(data.path, data.hash)
        return
      case 'navigate':
        if (isWebUrl(data.href)) win.location.assign(data.href)
        return
    }
  }

  const onMessage = (event: MessageEvent): void => {
    const { data, ports: transferred } = event
    const content = frame.contentWindow
    const accepted =
      event.origin === boot.contentOrigin &&
      content !== null &&
      within(content, event.source) &&
      isHello(data) &&
      handle !== null &&
      (data.handle === handle || data.handle === framedHandle) &&
      transferred.length === 1 &&
      // Only the frame's own document is the top page.
      data.nested === (event.source !== content)
    if (!accepted) {
      for (const port of transferred) port.close()
      return
    }
    const port = transferred[0]!
    const page = treePath(data.path)
    if (!data.nested) {
      // The top page is the page its grant named, whatever it says.
      if (page !== framedPath) {
        port.close()
        return
      }
      // A new top page: the frame's previous document and its pages are gone.
      closePorts()
      welcome(port, page, shown)
      return
    }
    // The frame's earlier page, if any, is gone: a closed port gives no
    // event in every browser, so its watches go now.
    const source = event.source as object
    const before = nestedPorts.get(source)
    if (before !== undefined) release(before)
    nestedPorts.set(source, port)
    // A nested page says which page it is; the deployment confirms it for
    // this person before it gets drafts or asks anything: sends, reads,
    // writes, uploads and watches all wait for a listening port.
    const navigation = shown
    api.confirm({ tree, page }).then(
      (found) => {
        if (
          disposed ||
          navigation !== shown ||
          found.path !== page ||
          !samePerson(found.email)
        ) {
          port.close()
          return
        }
        welcome(port, page, null)
      },
      () => port.close(),
    )
  }

  /** Takes an accepted page's port, then hands it its drafts and kept sends. */
  const welcome = (
    port: MessagePort,
    page: string,
    navigation: number | null,
  ): void => {
    port.addEventListener('message', (message) =>
      onPageMessage(message.data, port, page, navigation),
    )
    // Where the browser reports a closed port, its watches go at once.
    port.addEventListener('close', () => release(port))
    port.start()
    ports.set(port, page)
    void pageState(page).then((state) => {
      if (!ports.has(port)) return
      post(port, {
        type: 'welcome',
        v: BRIDGE_VERSION,
        me: me(),
        drafts: state.drafts,
        resume: state.resume,
      })
      if (win.navigator.onLine !== false) void replay(page)
    })
  }

  const onPopState = (): void => {
    const { pathname, hash } = win.location
    if (!pathname.startsWith(treePrefix)) {
      win.location.reload()
      return
    }
    void load(pathname.slice(treePrefix.length), hash)
  }

  const onVisibility = (): void => {
    if (doc.visibilityState === 'visible' && Date.now() - renewedAt >= HOUR) {
      void renew()
    }
  }

  return {
    start: async () => {
      win.addEventListener('message', onMessage)
      win.addEventListener('popstate', onPopState)
      doc.addEventListener('visibilitychange', onVisibility)
      win.addEventListener('online', replayOpen)
      renewTimer = win.setInterval(() => void renew(), HOUR)
      replayTimer = win.setInterval(replayOpen, REPLAY_INTERVAL)
      await load(boot.linkPath, win.location.hash)
    },
    dispose: () => {
      disposed = true
      loads++
      win.clearInterval(renewTimer)
      win.clearInterval(replayTimer)
      win.clearTimeout(retryTimer)
      win.removeEventListener('online', replayOpen)
      win.removeEventListener('message', onMessage)
      win.removeEventListener('popstate', onPopState)
      doc.removeEventListener('visibilitychange', onVisibility)
      closePorts()
      watches.dispose()
    },
  }
}
