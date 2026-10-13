// One per tree: it holds the sockets watching the tree, sends each the bare
// hints the Worker addresses to it, and closes them when access changes. It
// keeps no records and decides nothing about access: the Worker checks who
// may read what, at admission and for every hint.
import type {
  AgentKeyId,
  PersonId,
  SessionId,
  TreeId,
} from '@dossier/contracts'
import { DurableObject } from 'cloudflare:workers'

import type { CloseSockets } from '../core/change-feed.ts'

/** The header the Worker hands a checked watch over with. */
export const WATCH_HEADER = 'Dossier-Watch'
/** The hub's answer names the socket it holds, until the Worker admits it. */
export const SOCKET_HEADER = 'Dossier-Socket'

/**
 * Who watches, and the paths they may read, as `[sub, tree path]`. A visitor
 * has no person, session or key.
 */
export interface WatchHeader {
  readonly tree: TreeId
  readonly person: PersonId | null
  readonly session: SessionId | null
  readonly key: AgentKeyId | null
  readonly paths: readonly (readonly [number, string])[]
}

/** A socket the hub holds, as the Worker sees it to address hints. */
export interface Subscriber {
  readonly id: string
  readonly person: PersonId | null
  readonly session: SessionId | null
  readonly key: AgentKeyId | null
  readonly paths: readonly (readonly [number, string])[]
}

interface Attachment extends Subscriber {
  readonly tree: TreeId
  /** False until the Worker has checked access again after holding it. */
  readonly admitted: boolean
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isOptional = (value: unknown) => value === null || isString(value)

const readHeader = (text: string | null): WatchHeader | null => {
  if (text === null) return null
  try {
    const value = JSON.parse(text) as Partial<WatchHeader>
    if (
      !isString(value.tree) ||
      !isOptional(value.person) ||
      !isOptional(value.session) ||
      !isOptional(value.key) ||
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

const attachmentOf = (ws: WebSocket) =>
  ws.deserializeAttachment() as Attachment | null

export class TreeHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Keepalives are answered without waking the hub.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    )
  }

  /**
   * Upgrades the Worker already checked, carrying Dossier-Watch. The socket
   * is held, closed to hints, until `admit` names it.
   */
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
    const id = crypto.randomUUID()
    const tags = [
      `socket:${id}`,
      watch.person === null ? 'visitor' : `person:${watch.person}`,
      ...(watch.session === null ? [] : [`session:${watch.session}`]),
      ...(watch.key === null ? [] : [`key:${watch.key}`]),
    ]
    this.ctx.acceptWebSocket(server, tags)
    server.serializeAttachment({
      id,
      tree: watch.tree,
      person: watch.person,
      session: watch.session,
      key: watch.key,
      paths: watch.paths,
      admitted: false,
    } satisfies Attachment)
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { [SOCKET_HEADER]: id },
    })
  }

  /** Opens a held socket to hints; false when it was closed meanwhile. */
  async admit(id: string): Promise<boolean> {
    const [ws] = this.ctx.getWebSockets(`socket:${id}`)
    const attachment = ws === undefined ? null : attachmentOf(ws)
    if (ws === undefined || attachment === null) return false
    if (ws.readyState !== WebSocket.OPEN) return false
    ws.serializeAttachment({ ...attachment, admitted: true })
    return true
  }

  /** Closes the named sockets: refused, or no longer the caller's to keep. */
  async drop(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      for (const ws of this.ctx.getWebSockets(`socket:${id}`)) closeQuietly(ws)
    }
  }

  /** Every admitted socket, for the Worker to address a change's hints. */
  async subscribers(): Promise<readonly Subscriber[]> {
    const out: Subscriber[] = []
    for (const ws of this.ctx.getWebSockets()) {
      const a = attachmentOf(ws)
      if (a === null || !a.admitted) continue
      out.push({
        id: a.id,
        person: a.person,
        session: a.session,
        key: a.key,
        paths: a.paths,
      })
    }
    return out
  }

  /** Sends each named socket its bare hint: never a sequence, path or actor. */
  async notify(hints: readonly { id: string; sub: number }[]): Promise<void> {
    for (const { id, sub } of hints) {
      for (const ws of this.ctx.getWebSockets(`socket:${id}`)) {
        const a = attachmentOf(ws)
        if (a === null || !a.admitted) continue
        try {
          ws.send(JSON.stringify({ type: 'changed', tree: a.tree, sub }))
        } catch {
          // A socket closing meanwhile misses nothing it needs: it refetches.
        }
      }
    }
  }

  /** Closes held and admitted sockets alike: they reconnect and are checked. */
  async close(who: CloseSockets): Promise<void> {
    const sockets =
      'all' in who
        ? this.ctx.getWebSockets()
        : who.people.flatMap((person) =>
            this.ctx.getWebSockets(`person:${person}`),
          )
    for (const ws of sockets) closeQuietly(ws)
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

const closeQuietly = (ws: WebSocket) => {
  try {
    ws.close(ACCESS_CHANGED, 'access changed')
  } catch {
    // Already closed.
  }
}
