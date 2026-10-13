// Requests to the shell over the page's port, answered by id, and the notices
// the page sends without waiting for an answer.
import {
  DossierError,
  type DraftValues,
  type JsonObject,
  type PageToShell,
  type SendRequest,
  type ShellToPage,
} from '@dossier/contracts/bridge'
import type { HostPort } from './create-page-client.ts'

/** What the page asks the shell, without the request id. */
export type RequestOp =
  | { readonly op: 'read'; readonly path: string }
  | { readonly op: 'send'; readonly send: SendRequest }
  | { readonly op: 'withdraw'; readonly path: string; readonly opId: string }
  | {
      readonly op: 'write'
      readonly path: string
      readonly patch: JsonObject
      readonly replace: boolean
      readonly opId: string
      readonly seq: number
    }
  | {
      readonly op: 'upload'
      readonly file: Blob
      readonly name: string
      readonly contentType: string
      readonly opId: string
      readonly seq: number
    }
  | { readonly op: 'watch'; readonly sub: number; readonly path: string }
  | { readonly op: 'unwatch'; readonly sub: number }

/** The shell's answer to a pending send it replayed, by formKey. */
export type Resumed = Extract<ShellToPage, { type: 'resumed' }>

export interface Requests {
  /** Resolves with the answer's value; rejects with a DossierError. */
  readonly request: (op: RequestOp) => Promise<unknown>
  /** A form's unsent values, or null once there are none. */
  readonly draft: (form: string, values: DraftValues | null) => void
  /** Takes the shell's results and resumed notices; false for anything else. */
  readonly receive: (message: ShellToPage) => boolean
  /** Where resumed notices go; they wait here until a listener is set. */
  readonly onResumed: (listener: (notice: Resumed) => void) => void
}

export const createRequests = (
  port: Pick<HostPort, 'postMessage'>,
): Requests => {
  let next = 1
  const waiting = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void
      readonly reject: (error: DossierError) => void
    }
  >()
  let listener: ((notice: Resumed) => void) | null = null
  const early: Resumed[] = []

  const post = (message: PageToShell): void => {
    // A MessagePort's postMessage takes no target origin.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    port.postMessage(message)
  }

  return {
    request: (op) =>
      new Promise((resolve, reject) => {
        const id = next++
        waiting.set(id, { resolve, reject })
        post({ type: 'request', id, ...op })
      }),
    draft: (form, values) => post({ type: 'draft', form, values }),
    receive: (message) => {
      if (message.type === 'result') {
        const pending = waiting.get(message.id)
        if (pending === undefined) return true
        waiting.delete(message.id)
        if (message.ok) pending.resolve(message.value)
        else pending.reject(new DossierError(message.error))
        return true
      }
      if (message.type === 'resumed') {
        if (listener === null) early.push(message)
        else listener(message)
        return true
      }
      return false
    },
    onResumed: (set) => {
      listener = set
      for (const notice of early.splice(0)) set(notice)
    },
  }
}
