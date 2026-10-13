import type {
  AgentKeyId,
  NodeId,
  Person,
  SessionId,
  TreeId,
} from '@dossier/contracts'
import { Context } from 'effect'

/** How a request reached Dossier. Only the edge creates one. */
export type Via =
  /** The shell or a screen, on the main host. */
  | { readonly kind: 'browser'; readonly sessionId: SessionId }
  /** Frame content on the tree's own content host, through a view handle. */
  | {
      readonly kind: 'handle'
      readonly treeId: TreeId
      readonly sessionId: SessionId | null
      readonly anonSessionId: string | null
      /** SHA-256 of the handle, which names the sequences issued to it. */
      readonly handleHash: string
    }
  | {
      readonly kind: 'agent'
      readonly keyId: AgentKeyId
      readonly scope: NodeId | null
      readonly readOnly: boolean
    }
  | { readonly kind: 'visitor'; readonly anonSessionId: string | null }
  | {
      readonly kind: 'system'
      readonly job: 'purge' | 'sweep' | 'deliver'
    }

/** Who is asking: the one vocabulary for it. */
export interface Caller {
  readonly person: Person | null
  readonly via: Via
  /** cf-ray, or a random id in tests. */
  readonly requestId: string
}

export class CurrentCaller extends Context.Tag('CurrentCaller')<
  CurrentCaller,
  Caller
>() {}

export const visitor = (requestId: string): Caller => ({
  person: null,
  via: { kind: 'visitor', anonSessionId: null },
  requestId,
})
