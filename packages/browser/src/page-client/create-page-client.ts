import {
  DossierError,
  WINDOW_NAME_PREFIX,
  isShellToPage,
  readTopBoot,
  type Doc,
  type DraftValues,
  type Me,
  type PageBootstrap,
} from '@dossier/contracts/bridge'
import { startForms, type FormsController } from './forms.ts'
import { startKit } from './kit.ts'
import { trackLocation } from './location.ts'
import { createRequests } from './requests.ts'

export type { Doc } from '@dossier/contracts/bridge'

/** Where a managed form stands; 'closed' is final for the page load. */
export type FormState =
  | 'idle'
  | 'draft'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'closed'

/** The detail of the `dossier:state` event a managed form fires. */
export interface DossierStateDetail {
  readonly state: FormState
  readonly error: DossierError | null
  readonly doc: Doc | null
}

/**
 * Where the sends of managed forms come from: the submit events page code let
 * through, and submit() calls. Sends that come before the forms controller
 * starts wait for it.
 */
export interface SubmitSource {
  readonly connect: (handler: FormsController['submitted']) => void
}

export interface Dossier {
  /** Null for a visitor, and for a nested page until ready. */
  readonly me: Me | null
  readonly page: {
    readonly path: string
    readonly push: number
    readonly embedded: boolean
    readonly exported: boolean
  }
  /** Identity in place; already resolved for the top page. */
  readonly ready: Promise<void>
}

export type HostPort = Pick<
  MessagePort,
  'postMessage' | 'addEventListener' | 'removeEventListener' | 'start' | 'close'
>

/** How long a nested page waits for the shell's welcome. */
export const WELCOME_TIMEOUT = 10_000

/** The page client behind `window.dossier`. */
export const createPageClient = (deps: {
  readonly bootstrap: PageBootstrap
  readonly port: HostPort
  readonly window: Window
  readonly submits?: SubmitSource
  /** Called once the forms controller starts. */
  readonly onForms?: (forms: FormsController) => void
}): Dossier => {
  const { bootstrap, port, window: win } = deps
  // Components start loading before any author script runs.
  startKit({ window: win, kit: bootstrap.kit, used: bootstrap.used })
  const embedded = win.parent !== win.top
  const alone = win.top === win

  // The shell sets the top page's boot data. A nested page's name is set by
  // the page around it, so it is cleared but never believed.
  const name = win.name
  let boot = null
  if (name.startsWith(WINDOW_NAME_PREFIX)) {
    win.name = ''
    if (!embedded) boot = readTopBoot(name)
  }

  let me: Me | null = boot?.me ?? null
  let welcomed = (): void => {}
  let timer: number | undefined
  const ready =
    boot !== null || alone
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          welcomed = resolve
          timer = win.setTimeout(() => {
            reject(
              new DossierError({
                code: 'unavailable',
                message: 'The page could not reach Dossier.',
                fix: null,
                path: null,
              }),
            )
          }, WELCOME_TIMEOUT)
        })
  // Page code that never awaits `ready` should not see an unhandled rejection.
  ready.catch(() => {})

  const requests = createRequests(port)
  let formsAsked = false
  /** Starts the forms controller once identity is known and the document is parsed. */
  const beginForms = (
    drafts: Readonly<Record<string, DraftValues>>,
    resume: readonly string[],
  ): void => {
    // A page opened on its own has no shell to send through.
    if (formsAsked || alone) return
    formsAsked = true
    const begin = (): void => {
      const controller = startForms({
        window: win,
        bootstrap,
        me: () => me,
        drafts,
        resume,
        requests,
      })
      requests.onResumed(controller.resumed)
      deps.submits?.connect(controller.submitted)
      deps.onForms?.(controller)
    }
    const doc = win.document
    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', begin, { once: true })
    } else {
      begin()
    }
  }

  port.addEventListener('message', (event) => {
    const data: unknown = event.data
    if (!isShellToPage(data)) return
    if (data.type !== 'welcome') {
      requests.receive(data)
      return
    }
    me = data.me
    win.clearTimeout(timer)
    welcomed()
    beginForms(data.drafts, data.resume)
  })
  port.start()
  if (boot !== null) beginForms(boot.drafts, boot.resume)

  if (!embedded && !alone) trackLocation({ window: win, bootstrap, port })

  const page = Object.freeze({
    path: bootstrap.path,
    push: bootstrap.push,
    embedded,
    exported: false,
  })
  return Object.freeze({
    get me() {
      return me
    },
    page,
    ready,
  })
}
