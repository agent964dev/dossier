// Watching through real upgrades and the real tree hub: who may connect,
// which paths a socket follows, what a hint carries, and closing.
import type { OpId, Person, TreeId } from '@dossier/contracts'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Data, type Caller } from '../../src/core/index.ts'
import { Browser, signedIn } from '../support/browser.ts'
import { pageWith, pushForms, seqOf, type FormTree } from '../support/forms.ts'
import { harness, ORIGIN } from '../support/harness.ts'
import { keySecretFor } from '../support/keys.ts'
import { callerOf, fresh, runAs } from '../support/people.ts'
import { nodeAt, share, workspace } from '../support/trees.ts'

afterEach(() => harness.reset())

const FILES = {
  'open/page.html': pageWith('<p>Open</p>', 'Open'),
  'private/page.html': pageWith('<p>Private</p>', 'Private'),
}

let owner: Person
let ownerBrowser: Browser
let ownerCaller: Caller
let guest: Person
let guestBrowser: Browser
let tree: FormTree

beforeAll(async () => {
  ownerBrowser = await signedIn(fresh())
  ownerCaller = await callerOf(ownerBrowser)
  owner = ownerCaller.person!
  const ws = await workspace(owner)
  tree = await pushForms(owner, ws, FILES)
  guestBrowser = await signedIn(fresh())
  guest = (await callerOf(guestBrowser)).person!
  await share(
    tree.treeId,
    (await nodeAt(tree.treeId, 'open'))!.id,
    'email',
    guest.email.toLowerCase(),
    'write',
    owner,
  )
})

const watchUrl = (paths: readonly string[], treeName: string = tree.treeId) => {
  const query = new URLSearchParams({ tree: treeName })
  for (const path of paths) query.append('path', path)
  return `/_/api/watch?${query}`
}

/** An upgrade as the shell's socket sends it: the cookie, the main origin. */
const upgradeAs = (
  browser: Browser,
  paths: readonly string[],
  headers: Record<string, string> = { origin: ORIGIN },
) =>
  browser.fetch(watchUrl(paths), {
    purpose: 'none',
    headers: { upgrade: 'websocket', ...headers },
  })

interface Socket {
  readonly ws: WebSocket
  /** The next message, or null after `ms`. */
  readonly next: (ms?: number) => Promise<unknown>
  readonly closed: Promise<{ code: number; reason: string }>
}

const open = (response: Response): Socket => {
  expect(response.status).toBe(101)
  const ws = response.webSocket
  if (ws === null) throw new Error('no socket in the 101')
  ws.accept()
  const queue: unknown[] = []
  let waiting: ((value: unknown) => void) | null = null
  ws.addEventListener('message', (event) => {
    const text = String(event.data)
    const value: unknown = text.startsWith('{') ? JSON.parse(text) : text
    if (waiting !== null) {
      const resolve = waiting
      waiting = null
      resolve(value)
    } else queue.push(value)
  })
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (event) =>
      resolve({ code: event.code, reason: event.reason }),
    ),
  )
  return {
    ws,
    closed,
    next: (ms = 2000) =>
      queue.length > 0
        ? Promise.resolve(queue.shift())
        : new Promise((resolve) => {
            const timer = setTimeout(() => {
              waiting = null
              resolve(null)
            }, ms)
            waiting = (value) => {
              clearTimeout(timer)
              resolve(value)
            }
          }),
  }
}

const write = async (caller: Caller, path: string, page: string) => {
  const seq = await seqOf(tree)
  return runAs(
    caller,
    Effect.flatMap(Data, (data) =>
      data.write({
        tree: tree.treeId as TreeId,
        page,
        path,
        patch: { at: Date.now() },
        replace: false,
        opId: crypto.randomUUID() as OpId,
        seq,
      }),
    ),
  )
}

describe('a watch upgrade', () => {
  it('is refused without the main host Origin or a valid key', async () => {
    const bare = await upgradeAs(guestBrowser, ['open/'], {})
    expect(bare.status).toBe(401)
    expect(await bare.json()).toMatchObject({
      error: { code: 'sign_in_required' },
    })
    const elsewhere = await upgradeAs(guestBrowser, ['open/'], {
      origin: 'https://evil.example',
    })
    expect(elsewhere.status).toBe(401)
    const badKey = await new Browser().fetch(watchUrl(['open/']), {
      purpose: 'none',
      headers: { upgrade: 'websocket', authorization: 'Bearer dsk_unknown' },
    })
    expect(badKey.status).toBe(401)
    const malformed = await upgradeAs(guestBrowser, ['open/'], {
      origin: ORIGIN,
      authorization: 'Bearer',
    })
    expect(malformed.status).toBe(401)
  })

  it('answers 404 when no path is readable, the tree missing alike', async () => {
    const none = await upgradeAs(guestBrowser, ['private/'])
    expect(none.status).toBe(404)
    expect(await none.json()).toMatchObject({ error: { code: 'not_found' } })
    const missing = await guestBrowser.fetch(
      watchUrl(['open/'], 'nosuchworkspace/nosuchtree'),
      { purpose: 'none', headers: { upgrade: 'websocket', origin: ORIGIN } },
    )
    expect(missing.status).toBe(404)
  })

  it('leaves out an unreadable path, and sends a bare hint per matched subscription', async () => {
    // sub 0 unreadable, sub 1 readable.
    const socket = open(await upgradeAs(guestBrowser, ['private/', 'open/']))
    await write(ownerCaller, 'private/x.json', 'private/page.html')
    await write(ownerCaller, 'open/notes.json', 'open/page.html')
    const hint = await socket.next()
    expect(hint).toEqual({
      type: 'changed',
      tree: tree.treeId,
      sub: 1,
    })
    // Nothing came for the private write before it.
    expect(await socket.next(300)).toBeNull()
    socket.ws.close(1000, 'done')
  })

  it('sends nothing for a commit elsewhere in the tree', async () => {
    const socket = open(await upgradeAs(ownerBrowser, ['open/a/']))
    await write(ownerCaller, 'open/b.json', 'open/page.html')
    expect(await socket.next(500)).toBeNull()
    await write(ownerCaller, 'open/a/c.json', 'open/page.html')
    expect(await socket.next()).toMatchObject({ type: 'changed', sub: 0 })
    socket.ws.close(1000, 'done')
  })

  it('takes an agent key in the Authorization header, with no Origin', async () => {
    const secret = await keySecretFor(owner)
    const socket = open(
      await new Browser().fetch(watchUrl(['open/']), {
        purpose: 'none',
        headers: { upgrade: 'websocket', authorization: `Bearer ${secret}` },
      }),
    )
    await write(ownerCaller, 'open/key.json', 'open/page.html')
    expect(await socket.next()).toMatchObject({ type: 'changed', sub: 0 })
    socket.ws.close(1000, 'done')
  })

  it('closes only the named person sockets on close({ people })', async () => {
    const guestSocket = open(await upgradeAs(guestBrowser, ['open/']))
    const ownerSocket = open(await upgradeAs(ownerBrowser, ['open/']))
    const hub = env.TREE_HUB.get(env.TREE_HUB.idFromName(tree.treeId))
    await hub.close({ people: [guest.id] })
    expect(await guestSocket.closed).toEqual({
      code: 4001,
      reason: 'access changed',
    })
    await write(ownerCaller, 'open/after.json', 'open/page.html')
    expect(await ownerSocket.next()).toMatchObject({ type: 'changed' })
    ownerSocket.ws.close(1000, 'done')
  })

  it('answers ping with pong', async () => {
    const socket = open(await upgradeAs(ownerBrowser, ['']))
    socket.ws.send('ping')
    expect(await socket.next()).toBe('pong')
    socket.ws.close(1000, 'done')
  })
})
