// One per tree: it relays bare hints to the sockets watching the tree and
// closes them when access changes. It keeps no records: what changed is read
// from the events route, which checks access.
import type {
  AgentKeyId,
  PersonId,
  SessionId,
  TreeId,
} from '@dossier/contracts'
import { DurableObject } from 'cloudflare:workers'

import type { CloseSockets } from '../core/change-feed.ts'
import { matching } from './match.ts'

/** The header the Worker hands a checked watch over with. */
export const WATCH_HEADER = 'Dossier-Watch'

/** Who watches, and the paths they may read, as `[sub, tree path]`. */
export interface WatchHeader {
  readonly tree: TreeId
  readonly person: PersonId
  readonly session: SessionId | null
  readonly key: AgentKeyId | null
  readonly paths: readonly (readonly [number, string])[]
}

interface Attachment {
  readonly tree: TreeId
  readonly paths: readonly (readonly [number, string])[]
}

const isString = (value: unknown): value is string => typeof value === 'string'

const readHeader = (text: string | null): WatchHeader | null => {
  if (text === null) return null
  try {
    const value = JSON.parse(text) as Partial<WatchHeader>
    if (
      !isString(value.tree) ||
      !isString(value.person) ||
      !(value.session === null || isString(value.session)) ||
      !(value.key === null || isString(value.key)) ||
      !Array.isArray(value.paths) ||
      !value.paths.every(
        (p) =>
          Array.isArray(p) &&
          p.length === 2 &&
          Number.isInteger(p[0]) &&
          isString(p[1]),
      )
    ) {
      return null
    }
    return value as WatchHeader
  } catch {
    return null
  }
}

/** Closed because what the socket may read changed; it reconnects. */
export const ACCESS_CHANGED = 4001

export class TreeHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Keepalives are answered without waking the hub.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    )
  }

  /** Upgrades the Worker already checked, carrying Dossier-Watch. */
  override async fetch(request: Request): Promise<Response> {
    const watch = readHeader(request.headers.get(WATCH_HEADER))
    if (
      watch === null ||
      request.headers.get('upgrade')?.toLowerCase() !== 'websocket'
    ) {
      return new Response(null, { status: 404 })
    }
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    const tags = [
      `person:${watch.person}`,
      watch.session === null ? `key:${watch.key}` : `session:${watch.session}`,
    ]
    this.ctx.acceptWebSocket(server, tags)
    server.serializeAttachment({
      tree: watch.tree,
      paths: watch.paths,
    } satisfies Attachment)
    return new Response(null, { status: 101, webSocket: client })
  }

  /** One hint per matched subscription: the sequence, never a path or an actor. */
  async changed(seq: number, paths: readonly string[]): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment === null) continue
      for (const sub of matching(attachment.paths, paths)) {
        try {
          ws.send(
            JSON.stringify({
              type: 'changed',
              tree: attachment.tree,
              seq,
              sub,
            }),
          )
        } catch {
          // A socket closing meanwhile misses nothing it needs: it refetches.
        }
      }
    }
  }

  async close(who: CloseSockets): Promise<void> {
    const sockets =
      'all' in who
        ? this.ctx.getWebSockets()
        : who.people.flatMap((person) =>
            this.ctx.getWebSockets(`person:${person}`),
          )
    for (const ws of sockets) {
      try {
        ws.close(ACCESS_CHANGED, 'access changed')
      } catch {
        // Already closed.
      }
    }
  }

  override webSocketMessage(): void {
    // Only 'ping' is expected, and the auto-response answers it.
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason)
    } catch {
      // The runtime already completed the close.
    }
  }
}
