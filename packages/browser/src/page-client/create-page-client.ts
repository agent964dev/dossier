import {
  DossierError,
  WINDOW_NAME_PREFIX,
  isShellToPage,
  readTopBoot,
  type Me,
  type PageBootstrap,
} from '@dossier/contracts/bridge'
import { startKit } from './kit.ts'
import { trackLocation } from './location.ts'

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

  port.addEventListener('message', (event) => {
    if (!isShellToPage(event.data)) return
    me = event.data.me
    win.clearTimeout(timer)
    welcomed()
  })
  port.start()

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
