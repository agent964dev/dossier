import type {
  DocWire,
  ExportData,
  FormInfo,
  Me,
  PageBootstrap,
  ShellToPage,
  Thread,
} from '@dossier/contracts/bridge'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  EXPORT_BASE,
  baseFileUrl,
  baseOfModule,
  nameInDataUrl,
} from '../src/base/export-url.ts'
import type { Dossier } from '../src/page-client/create-page-client.ts'
import {
  EXPORT_SAVED_TEXT,
  EXPORT_STORAGE_PREFIX,
  createExportHost,
  type ExportStorage,
} from '../src/page-client/export-host.ts'
import { install } from '../src/page-client/install.ts'
import { startKit } from '../src/page-client/kit.ts'
import { BOOTSTRAP } from './fake-shell.ts'
import { domWindow, flush } from './ports.ts'

const SARA: Me = { email: 'sara@acme.com', name: 'Sara', role: 'respond' }
const EXPORTED_AT = '2026-10-11T12:00:00.000Z'
const NOW = '2026-10-12T09:15:30.000Z'
const FILE_URL = 'file:///Users/sara/Downloads/plan.html'
const KEY = `${EXPORT_STORAGE_PREFIX}t1:questions/plan.html`

const PERSON: FormInfo = {
  n: 1,
  host: 'n1',
  target: 'questions/answers/',
  id: null,
  kind: 'person',
  closesAt: null,
  closed: false,
}
const ENTRIES: FormInfo = {
  n: 2,
  host: 'n1',
  target: 'questions/ideas/',
  id: null,
  kind: 'entries',
  closesAt: null,
  closed: false,
}
const SHARED: FormInfo = {
  n: 3,
  host: 'n1',
  target: 'board.json',
  id: 'board',
  kind: 'shared',
  closesAt: null,
  closed: false,
}

const EXPORTED_BOOTSTRAP: PageBootstrap = {
  ...BOOTSTRAP,
  export: true,
  forms: [PERSON, ENTRIES, SHARED],
}

const wire = (
  path: string,
  data: unknown,
  by = 'sara@acme.com',
  at = '2026-10-10T08:00:00.000Z',
): DocWire => ({ path, data, by, at, push: 2 as DocWire['push'] })

const LEE_COMMENT =
  'questions/plan.comments/lee@acme.com/2026-10-10T09-00-00.json'

const comment = (text: string, replyTo: string | null = null) => ({
  text,
  anchor: null,
  label: null,
  pin: null,
  replyTo,
  stance: null,
  mentions: [],
})

const DATA: ExportData = {
  v: 1,
  at: EXPORTED_AT,
  link: 'https://main.test/agent964/acme/questions/plan',
  me: SARA,
  files: [
    wire('questions/answers/sara@acme.com.json', {
      name: 'Sara',
      notes: 'first',
      nested: { a: 1, b: 2 },
    }),
    wire('board.json', { votes: 3, title: 'Board' }, 'lee@acme.com'),
    wire(
      LEE_COMMENT,
      comment('Looks good'),
      'lee@acme.com',
      '2026-10-10T09:30:00.000Z',
    ),
  ],
  comments: {
    [LEE_COMMENT]: { created: '2026-10-10T09:00:00.000Z', revision: 2 },
  },
  linked: [],
}

/** A browser storage in memory that later pages share. */
const memoryStorage = () => {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, String(value))
    },
    removeItem: (key: string) => {
      items.delete(key)
    },
  }
}

const FORM_BODY = `
  <form data-dossier-form="1">
    <input name="name">
    <textarea name="notes"></textarea>
    <input type="file" name="cv">
    <button name="action" value="send">Send</button>
  </form>
  <form data-dossier-form="2">
    <input name="idea">
    <button>Add</button>
  </form>`

/**
 * A page downloaded as one file, opened from disk: the top window, with the
 * network, sockets and messages to the window above watched.
 */
const openExport = (
  options: {
    /** 'refused': reading localStorage throws, as for some files. */
    readonly storage?: ExportStorage | 'refused'
    readonly body?: string
    readonly name?: string
    readonly data?: ExportData
  } = {},
) => {
  const win = domWindow(FILE_URL)
  const doc = win.document
  const script = (id: string, value: unknown) => {
    const element = doc.createElement('script')
    element.setAttribute('type', 'application/json')
    element.id = id
    element.textContent = JSON.stringify(value)
    return element
  }
  doc.head.prepend(
    script('dossier-bootstrap', EXPORTED_BOOTSTRAP),
    script('dossier-export', options.data ?? DATA),
  )
  doc.body.innerHTML = options.body ?? ''
  const storage = options.storage ?? memoryStorage()
  Object.defineProperty(
    win,
    'localStorage',
    storage === 'refused'
      ? {
          get: () => {
            throw new DOMException(
              'The operation is insecure.',
              'SecurityError',
            )
          },
          configurable: true,
        }
      : { value: storage, configurable: true },
  )
  win.name = options.name ?? ''

  const fetches = vi.spyOn(win, 'fetch')
  const globalFetches = vi.spyOn(globalThis, 'fetch')
  const sockets = vi.fn()
  const channels = vi.fn()
  Object.assign(win, { WebSocket: sockets, MessageChannel: channels })
  vi.stubGlobal('WebSocket', sockets)
  const top = win.top as unknown as Window
  const posts = vi.spyOn(top, 'postMessage')

  const installed = install(win as unknown as Window)
  const dossier = (win as unknown as { dossier: Dossier }).dossier
  const form = (n: number) =>
    doc.querySelector(
      `form[data-dossier-form="${n}"]`,
    ) as unknown as HTMLFormElement
  const status = (n: number) =>
    form(n).querySelector('output[data-dossier-status]')?.textContent ?? ''
  return {
    win,
    doc,
    top,
    installed,
    dossier,
    form,
    status,
    untouched: () => {
      expect(fetches).not.toHaveBeenCalled()
      expect(globalFetches).not.toHaveBeenCalled()
      expect(sockets).not.toHaveBeenCalled()
      expect(channels).not.toHaveBeenCalled()
      expect(posts).not.toHaveBeenCalled()
    },
  }
}

/** What storage keeps for the page: its files by tree path. */
const savedFiles = (storage: ReturnType<typeof memoryStorage>) => {
  const raw = storage.items.get(KEY)
  if (raw === undefined) return new Map<string, unknown>()
  const value = JSON.parse(raw) as { files: [string, unknown][] }
  return new Map(value.files)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('install in a page downloaded as one file', () => {
  test('never reaches the network, a socket or the window above', async () => {
    const page = openExport({ body: FORM_BODY })
    await flush()
    await page.dossier.read('answers/~.json')
    await page.dossier.read('answers/')
    const stop = page.dossier.watch('../board.json', () => {})
    await page.dossier.write('answers/~.json', { notes: 'second' })
    await page.dossier.withdraw('answers/~.json')
    await expect(page.dossier.upload(new Blob(['x']))).rejects.toThrow()
    page.form(1).submit()
    await flush()
    stop()
    await flush()
    page.untouched()
  })

  test('is exported and ready at once, as its exporter, leaving the window name alone', async () => {
    const page = openExport({ name: 'dossier-boot:{"v":1,"me":null}' })
    expect(page.dossier.page).toEqual({
      path: '/questions/plan.html',
      push: 2,
      embedded: false,
      exported: true,
    })
    expect(page.dossier.me).toEqual(SARA)
    await expect(page.dossier.ready).resolves.toBeUndefined()
    expect(page.win.name).toBe('dossier-boot:{"v":1,"me":null}')
  })

  test('a read of a form target gives the snapshot’s file relative to the page', async () => {
    const { dossier } = openExport()
    expect(await dossier.read('answers/~.json')).toEqual({
      path: 'answers/sara@acme.com.json',
      data: { name: 'Sara', notes: 'first', nested: { a: 1, b: 2 } },
      by: 'sara@acme.com',
      at: '2026-10-10T08:00:00.000Z',
      push: 2,
    })
    expect(await dossier.read('/board.json')).toMatchObject({
      path: '../board.json',
      data: { votes: 3, title: 'Board' },
      by: 'lee@acme.com',
    })
    expect((await dossier.read('answers/')).map((doc) => doc.path)).toEqual([
      'answers/sara@acme.com.json',
    ])
    expect(await dossier.read('answers/lee@acme.com.json')).toBeNull()
  })

  test('a write merges by RFC 7396 and survives a new page client on the same storage', async () => {
    const storage = memoryStorage()
    const first = openExport({ storage })
    const written = await first.dossier.write('answers/~.json', {
      notes: null,
      nested: { b: null, c: 3 },
    })
    const merged = { name: 'Sara', nested: { a: 1, c: 3 } }
    expect(written).toEqual({
      path: 'answers/sara@acme.com.json',
      data: merged,
      by: 'sara@acme.com',
      at: NOW,
      push: 2,
    })
    expect(storage.items.has(KEY)).toBe(true)

    const second = openExport({ storage })
    expect(await second.dossier.read('answers/~.json')).toEqual(written)
    // The snapshot itself is never changed: a page without the storage has it.
    const fresh = openExport()
    expect(await fresh.dossier.read('answers/~.json')).toMatchObject({
      data: { name: 'Sara', notes: 'first', nested: { a: 1, b: 2 } },
    })
  })

  test('a write to a folder is a new entry in the writer’s own folder there', async () => {
    const { dossier } = openExport()
    const entry = await dossier.write('notes/', { text: 'hi', gone: null })
    expect(entry).toMatchObject({
      path: 'notes/sara@acme.com/2026-10-12T09-15-30.json',
      data: { text: 'hi' },
    })
    const again = await dossier.write('notes/', { text: 'again' })
    expect(again.path).toBe('notes/sara@acme.com/2026-10-12T09-15-30-2.json')
    // A folder reads in path order, as in Dossier.
    expect((await dossier.read('notes/')).map((doc) => doc.data)).toEqual([
      { text: 'again' },
      { text: 'hi' },
    ])
  })

  test('a write to another person’s file is refused', async () => {
    const { dossier } = openExport()
    await expect(
      dossier.write('answers/lee@acme.com.json', { a: 1 }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  test('upload rejects with not_in_export', async () => {
    const storage = memoryStorage()
    const { dossier, win } = openExport({ storage })
    const file = new win.File(['%PDF'], 'cv.pdf', { type: 'application/pdf' })
    await expect(dossier.upload(file as unknown as File)).rejects.toMatchObject(
      {
        name: 'DossierError',
        code: 'not_in_export',
        fix: 'Open the live page in Dossier for this.',
      },
    )
    expect(storage.items.has(KEY)).toBe(false)
  })

  test('a watch has the value at once, then after each write in this browser', async () => {
    const { dossier } = openExport()
    const seen: unknown[] = []
    dossier.watch('answers/', (value) => {
      seen.push((value as { data: unknown }[]).map((doc) => doc.data))
    })
    await flush()
    expect(seen).toEqual([
      [{ name: 'Sara', notes: 'first', nested: { a: 1, b: 2 } }],
    ])
    await dossier.write('answers/~.json', { notes: 'second' })
    await flush()
    expect(seen.at(-1)).toEqual([
      { name: 'Sara', notes: 'second', nested: { a: 1, b: 2 } },
    ])
  })

  test('a withdrawal removes this browser’s copy, even after a reload', async () => {
    const storage = memoryStorage()
    const first = openExport({ storage })
    await first.dossier.withdraw('answers/~.json')
    expect(await first.dossier.read('answers/~.json')).toBeNull()
    const second = openExport({ storage })
    expect(await second.dossier.read('answers/~.json')).toBeNull()
    // A shared file belongs to nobody.
    await expect(
      second.dossier.withdraw('../board.json'),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('forms in a page downloaded as one file', () => {
  test('a send shows "Saved in this browser only." and keeps the answer', async () => {
    const page = openExport({ body: FORM_BODY })
    await flush()
    const name = page.form(1).querySelector('input[name="name"]')!
    ;(name as HTMLInputElement).value = 'Sara A.'
    page.form(1).submit()
    await flush()
    expect(page.status(1)).toBe(EXPORT_SAVED_TEXT)
    expect(page.form(1).getAttribute('data-state')).toBe('sent')
    expect(await page.dossier.read('answers/~.json')).toMatchObject({
      // The prefill put the answer sent before the export in the form.
      data: { name: 'Sara A.', notes: 'first' },
      at: NOW,
    })
  })

  test('a plain form’s file field keeps only the file’s name, size and type', async () => {
    const storage = memoryStorage()
    const page = openExport({ storage, body: FORM_BODY })
    await flush()
    const input = page.form(1).querySelector('input[name="cv"]')!
    const file = new page.win.File(['%PDF-1'], 'cv.pdf', {
      type: 'application/pdf',
    })
    // happy-dom takes a list of files for a file input.
    ;(input as unknown as { files: unknown }).files = [file]
    page.form(1).submit()
    await flush()
    const stored = savedFiles(storage).get(
      'questions/answers/sara@acme.com.json',
    ) as { doc: DocWire }
    expect((stored.doc.data as Record<string, unknown>).cv).toEqual({
      name: 'cv.pdf',
      size: 6,
      type: 'application/pdf',
    })
    expect(storage.items.get(KEY)).not.toContain('%PDF')

    // Sent again with no file chosen, the answer still names the file.
    ;(input as unknown as { files: unknown }).files = []
    const name = page.form(1).querySelector('input[name="name"]')!
    ;(name as HTMLInputElement).value = 'Sara B.'
    page.form(1).submit()
    await flush()
    expect(await page.dossier.read('answers/~.json')).toMatchObject({
      data: {
        name: 'Sara B.',
        cv: { name: 'cv.pdf', size: 6, type: 'application/pdf' },
      },
    })
  })

  test('an entries form adds an entry in the sender’s own folder', async () => {
    const page = openExport({ body: FORM_BODY })
    await flush()
    const idea = page.form(2).querySelector('input[name="idea"]')!
    ;(idea as HTMLInputElement).value = 'Ship sooner'
    page.form(2).submit()
    await flush()
    expect(page.status(2)).toBe(EXPORT_SAVED_TEXT)
    expect(await page.dossier.read('ideas/')).toEqual([
      expect.objectContaining({
        path: 'ideas/sara@acme.com/2026-10-12T09-15-30.json',
        data: { idea: 'Ship sooner' },
      }),
    ])
  })

  test('the prefill names an answer saved in this browser, and one sent before the export by its time', async () => {
    const storage = memoryStorage()
    const before = openExport({ storage, body: FORM_BODY })
    await flush()
    expect(before.status(1)).toMatch(/^Sent on /)
    before.form(1).submit()
    await flush()
    const after = openExport({ storage, body: FORM_BODY })
    await flush()
    expect(after.status(1)).toBe(EXPORT_SAVED_TEXT)
    const name = after.form(1).querySelector('input[name="name"]')!
    expect((name as HTMLInputElement).value).toBe('Sara')
  })

  test('with storage refused, everything still works for the tab', async () => {
    const page = openExport({ storage: 'refused', body: FORM_BODY })
    await flush()
    expect(page.dossier.page.exported).toBe(true)
    await page.dossier.write('answers/~.json', { notes: 'kept' })
    expect(await page.dossier.read('answers/~.json')).toMatchObject({
      data: { notes: 'kept' },
    })
    page.form(1).submit()
    await flush()
    expect(page.status(1)).toBe(EXPORT_SAVED_TEXT)
    page.untouched()
    // Nothing outlives the tab.
    const next = openExport({ storage: 'refused' })
    expect(await next.dossier.read('answers/~.json')).toMatchObject({
      data: { notes: 'first' },
    })
  })

  test('a storage that refuses a write keeps it for the tab', async () => {
    const storage = {
      ...memoryStorage(),
      setItem: () => {
        throw new DOMException('Full.', 'QuotaExceededError')
      },
    }
    const page = openExport({ storage, body: FORM_BODY })
    await flush()
    await page.dossier.write('answers/~.json', { notes: 'kept' })
    expect(await page.dossier.read('answers/~.json')).toMatchObject({
      data: { notes: 'kept' },
    })
    page.form(1).submit()
    await flush()
    expect(page.status(1)).toBe(EXPORT_SAVED_TEXT)
  })
})

describe('comments in a page downloaded as one file', () => {
  const threads = async (dossier: Dossier) =>
    (await dossier.read<Thread>('plan.comments/')).map((doc) => doc.data)

  test('a read assembles threads from the snapshot and this browser’s comments', async () => {
    const { dossier } = openExport()
    const [lee] = await threads(dossier)
    expect(lee).toMatchObject({
      root: {
        text: 'Looks good',
        by: 'lee@acme.com',
        at: '2026-10-10T09:00:00.000Z',
        edited: true,
        path: 'plan.comments/lee@acme.com/2026-10-10T09-00-00.json',
      },
      replies: [],
      resolved: false,
    })
    const root = lee!.root.path
    const reply = await dossier.write('plan.comments/', {
      text: '  Agreed  ',
      replyTo: root,
    })
    expect(reply.path).toBe(
      'plan.comments/sara@acme.com/2026-10-12T09-15-30.json',
    )
    await dossier.write('plan.comments/', {
      text: 'A question',
      anchor: 'intro',
    })
    await dossier.write('plan.comments/', { resolves: root })
    const after = await threads(dossier)
    expect(after).toHaveLength(2)
    expect(after[0]).toMatchObject({
      root: { text: 'Looks good' },
      replies: [{ text: 'Agreed', by: 'sara@acme.com', edited: false }],
      resolved: true,
      resolvedBy: 'sara@acme.com',
      resolvedAt: NOW,
    })
    expect(after[1]).toMatchObject({
      root: { text: 'A question', anchor: 'intro', replyTo: null },
    })
  })

  test('a withdrawal blanks a comment, which stays in its thread', async () => {
    const storage = memoryStorage()
    const first = openExport({ storage })
    const written = await first.dossier.write('plan.comments/', {
      text: 'Remove me',
      mentions: ['Lee@Acme.com'],
    })
    await first.dossier.write(written.path, { text: 'Remove me soon' })
    await first.dossier.withdraw(written.path)
    const second = openExport({ storage })
    const mine = (await threads(second.dossier)).find(
      (thread) => thread.root.by === 'sara@acme.com',
    )
    expect(mine?.root).toMatchObject({
      text: '',
      mentions: [],
      deleted: true,
      at: NOW,
    })
  })

  test('a comment written in this browser reaches a watch of the folder', async () => {
    const { dossier } = openExport()
    const seen: number[] = []
    dossier.watch('plan.comments/', (value) => {
      seen.push((value as unknown[]).length)
    })
    await flush()
    await dossier.write('plan.comments/', { text: 'New thread' })
    await flush()
    expect(seen).toEqual([1, 2])
  })
})

describe('the export host', () => {
  /** A page's end of the host: what it was told, and a way to ask. */
  const connect = (storage: ExportStorage | null) => {
    const port = createExportHost({
      data: DATA,
      bootstrap: EXPORTED_BOOTSTRAP,
      storage,
      now: () => new Date(NOW),
    })
    const told: ShellToPage[] = []
    port.addEventListener('message', (event) => {
      told.push((event as MessageEvent<ShellToPage>).data)
    })
    port.start()
    const ask = (message: unknown): void => {
      // A MessagePort's postMessage takes no target origin.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      port.postMessage(message)
    }
    return { ask, told }
  }

  test('welcomes the page as the exporter with the drafts this browser kept', async () => {
    const storage = memoryStorage()
    const first = connect(storage)
    await flush()
    expect(first.told).toEqual([
      { type: 'welcome', v: 1, me: SARA, drafts: {}, resume: [] },
    ])
    first.ask({
      type: 'draft',
      form: 'n1|questions/answers/|',
      values: { name: 'Sa' },
    })
    const second = connect(storage)
    await flush()
    expect(second.told[0]).toMatchObject({
      type: 'welcome',
      drafts: { 'n1|questions/answers/|': { name: 'Sa' } },
    })
  })

  test('answers what needs Dossier with not_in_export', async () => {
    const { ask, told } = connect(null)
    ask({
      type: 'request',
      id: 7,
      op: 'upload',
      file: new Blob(['x']),
      name: 'x.txt',
      contentType: 'text/plain',
      opId: 'o1',
      seq: 3,
    })
    await flush()
    expect(told.at(-1)).toMatchObject({
      type: 'result',
      id: 7,
      ok: false,
      error: { code: 'not_in_export' },
    })
  })

  test('a shared form merges what it sends into the shared file', async () => {
    const { ask, told } = connect(null)
    ask({
      type: 'request',
      id: 1,
      op: 'send',
      send: {
        form: { host: 'n1', target: 'board.json', id: 'board' },
        seq: 3,
        entries: [
          ['tag', 'a'],
          ['tag', 'b'],
        ],
        submitter: { name: 'vote', value: 'up' },
        opId: 'o1',
      },
    })
    await flush()
    expect(told.at(-1)).toEqual({
      type: 'result',
      id: 1,
      ok: true,
      value: {
        doc: {
          path: 'board.json',
          data: { votes: 3, title: 'Board', tag: ['a', 'b'], vote: 'up' },
          by: 'sara@acme.com',
          at: NOW,
          push: 2,
        },
        replayed: false,
      },
    })
  })
})

describe('the component loader in a page downloaded as one file', () => {
  test('imports each kit value exactly as written, for the import map', () => {
    const win = domWindow(FILE_URL)
    const load = vi.fn(() => new Promise<unknown>(() => {}))
    startKit({
      window: win as unknown as Window,
      kit: { 'acme-card': 'dossier-export/_components/acme-card.js' },
      used: ['acme-card'],
      exported: true,
      load,
    })
    expect(load).toHaveBeenCalledExactlyOnceWith(
      'dossier-export/_components/acme-card.js',
    )
  })
})

describe('base files in a page downloaded as one file', () => {
  test('a live page keeps its base layer’s paths', () => {
    expect(baseFileUrl('/_/base/b1', 'lib/katex/katex.css')).toBe(
      '/_/base/b1/lib/katex/katex.css',
    )
    expect(baseOfModule('https://t1.test/_/base/b1/_components/x.js')).toBe(
      'https://t1.test/_/base/b1',
    )
  })

  test('a component loaded from a data: URL takes the export prefix', () => {
    expect(baseOfModule('data:text/javascript;base64,AAAA')).toBe(EXPORT_BASE)
  })

  test('a data: URL keeps the name of the file it holds', () => {
    expect(
      nameInDataUrl('data:text/markdown;name=v1%2Fplan.md;base64,IyBQbGFu'),
    ).toBe('v1/plan.md')
    expect(nameInDataUrl('data:text/markdown;base64,IyBQbGFu')).toBeNull()
    expect(nameInDataUrl('v1/plan.md')).toBeNull()
  })
})
