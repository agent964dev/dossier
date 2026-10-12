import {
  BRIDGE_VERSION,
  DossierError,
  ERRORS,
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
import { within } from './frames.ts'
import type { ShellStore } from './store.ts'

export interface ViewGrant {
  readonly handle: string
  readonly expiresAt: string
  readonly seq: number
  readonly role: RoleName
  /** The tree path of the page or file the frame opens. */
  readonly path: string
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
}

/** doc null: the answer was withdrawn since. */
export interface SendResultWire {
  readonly doc: DocWire | null
  readonly replayed: boolean
}

/** The query of an upload, as the API takes it. */
export interface UploadParamsWire {
  readonly tree: string
  readonly page: string
  readonly seq: number
  readonly host: string
  readonly target: string
  readonly id: string | null
  /** The file field's name. */
  readonly field: string
  readonly name: string
  readonly type: string
  readonly size: number
  readonly sha256: string
  readonly opId: string
}

export interface UploadResultWire extends UploadRef {
  /** The tree path of the stored file. */
  readonly path: string
}

/** Every call rejects with a DossierError; offline when nothing answered. */
export interface ShellApi {
  readonly view: (i: {
    readonly tree: string
    readonly path: string
  }) => Promise<ViewGrant>
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
  }) => Promise<void>
}

export interface ShellDeps {
  readonly window: Window
  readonly frame: HTMLIFrameElement
  readonly boot: ShellBoot
  readonly api: ShellApi
  readonly store: ShellStore
}

const HOUR = 60 * 60 * 1000
/** How long the shell waits before reloading after an error that is not a refusal. */
export const RETRY_DELAY = 5000
/** How often the shell tries the sends it keeps while the tab is open. */
export const REPLAY_INTERVAL = 30_000

const FRAME_ATTRIBUTES: Readonly<Record<string, string>> = {
  id: 'dossier-page',
  title: '',
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

const hashOf = (hash: string): string =>
  hash === '' || hash.startsWith('#') ? hash : ''

type Request = Extract<PageToShell, { type: 'request' }>

const treePath = (path: string): string => path.replace(/^\/+/, '')

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

  let frame = deps.frame
  /** The newest grant's handle, for the next load and hello checks. */
  let handle: string | null = null
  /** The handle the page in the frame now was loaded with. */
  let framedHandle: string | null = null
  let role: RoleName = 'read'
  /** The link path of the page shown now. */
  let linkPath = boot.linkPath
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
  let adopted = false

  const me = (): Me | null => (boot.me === null ? null : { ...boot.me, role })
  /** Whose drafts these are: the person's email, or '' for a visitor. */
  const viewer = (): string => boot.me?.email ?? ''
  const tree = boot.tree.id

  const closePorts = (): void => {
    for (const port of ports.keys()) port.close()
    ports.clear()
  }

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

  const adoptOnce = async (): Promise<void> => {
    if (adopted || boot.me === null) return
    adopted = true
    await quietly(() => store.adoptDrafts('', boot.me!.email, tree), undefined)
  }

  /**
   * The kept sends of a page this viewer may send: a visitor's, or their
   * own. Another person's are dropped; their draft stays theirs.
   */
  const pendingFor = async (page: string): Promise<PendingSend[]> => {
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
    await adoptOnce()
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

  /** Uploads the send's files, then sends it with the stored uploads. */
  const deliver = async (
    page: string,
    send: SendRequest,
  ): Promise<SendResultWire> => {
    const entries: (readonly [string, string | UploadRef])[] = []
    for (const [field, value] of send.entries) {
      if (!isFile(value)) {
        entries.push([field, value])
        continue
      }
      const stored = await api.upload({
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
        opId: `${send.opId}:${field}`,
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
    })
  }

  /** After a send of a form succeeds: its draft and every kept send go. */
  const sent = async (page: string, form: FormRef, by: string | null) => {
    const key = formKey(form)
    await quietly(
      () => store.saveDraft(by ?? viewer(), tree, page, key, null),
      undefined,
    )
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
      const result = await deliver(page, send)
      await sent(page, send.form, boot.me?.email ?? null)
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
          const value = await deliver(page, send)
          await sent(page, send.form, send.by)
          tell(page, { type: 'resumed', form, ok: true, value })
        } catch (error) {
          tell(page, {
            type: 'resumed',
            form,
            ok: false,
            error: fieldsOf(error),
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

  const onRequest = (
    port: MessagePort,
    page: string,
    request: Request,
  ): void => {
    const email = boot.me?.email ?? null
    switch (request.op) {
      case 'read': {
        const path = resolvePath(page, request.path, email)
        if (path === null) {
          answer(port, request.id, {
            error: new DossierError({
              code: 'not_found',
              message: 'Not found.',
              fix: null,
              path: request.path,
            }),
          })
          return
        }
        api.read({ tree, path }).then(
          (value) => answer(port, request.id, { value }),
          (error: unknown) => answer(port, request.id, { error }),
        )
        return
      }
      case 'withdraw': {
        const path = resolvePath(page, request.path, email)
        if (path === null) {
          answer(port, request.id, {
            error: new DossierError({
              code: 'not_found',
              message: 'Not found.',
              fix: null,
              path: request.path,
            }),
          })
          return
        }
        api.withdraw({ tree, path, opId: request.opId }).then(
          () => answer(port, request.id, { value: null }),
          (error: unknown) => answer(port, request.id, { error }),
        )
        return
      }
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
    const state = await pageState(treePath(grant.path))
    if (current !== loads || disposed) return
    win.clearTimeout(retryTimer)
    shown = current
    handle = grant.handle
    framedHandle = grant.handle
    role = grant.role
    renewedAt = Date.now()
    linkPath = path

    // The sandbox comes from FRAME_ATTRIBUTES just below.
    // oxlint-disable-next-line react/iframe-missing-sandbox
    const next = doc.createElement('iframe')
    for (const [name, value] of Object.entries(FRAME_ATTRIBUTES)) {
      next.setAttribute(name, value)
    }
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
      const grant = await api.view({ tree: boot.tree.id, path: linkPath })
      // A load since then holds a fresher grant.
      if (disposed || current !== loads) return
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
    // A new top page: the frame's previous document and its pages are gone.
    if (!data.nested) closePorts()
    const navigation = data.nested ? null : shown
    port.addEventListener('message', (message) =>
      onPageMessage(message.data, port, page, navigation),
    )
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
    },
  }
}
