// MessagePort.postMessage takes no target origin.
// oxlint-disable unicorn/require-post-message-target-origin
import {
  DossierError,
  formKey,
  type DocWire,
  type FormRef,
  type PendingSend,
  type SendRequest,
} from '@dossier/contracts/bridge'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { shellApi } from '../src/shell/api.ts'
import {
  REPLAY_INTERVAL,
  RETRY_DELAY,
  type ViewGrant,
} from '../src/shell/create-shell.ts'
import { within } from '../src/shell/frames.ts'
import { BOOT, grant, openShell } from './fake-page.ts'
import { memoryStore } from './memory-store.ts'
import { FakePort, flush } from './ports.ts'

const HOUR = 60 * 60 * 1000

afterEach(() => {
  vi.useRealTimers()
})

const bootOf = (frame: HTMLIFrameElement) => {
  expect(frame.name.startsWith('dossier-boot:')).toBe(true)
  return JSON.parse(frame.name.slice('dossier-boot:'.length)) as unknown
}

describe('within', () => {
  const top = { parent: null as unknown }
  top.parent = top
  const root = { parent: top }
  const child = { parent: root }
  const grandchild = { parent: child }

  test('accepts the root and windows nested inside it', () => {
    expect(within(root as never, root as never)).toBe(true)
    expect(within(root as never, child as never)).toBe(true)
    expect(within(root as never, grandchild as never)).toBe(true)
  })

  test('refuses null, windows outside, and sources without a parent', () => {
    const outside = { parent: top }
    expect(within(root as never, null)).toBe(false)
    expect(within(root as never, outside as never)).toBe(false)
    expect(within(root as never, top as never)).toBe(false)
    expect(within(root as never, new FakePort() as never)).toBe(false)
  })

  test('walks at most maxDepth frames up', () => {
    expect(within(root as never, grandchild as never, 2)).toBe(true)
    expect(within(root as never, grandchild as never, 1)).toBe(false)
    let deep: { parent: unknown } = root
    for (let i = 0; i < 9; i++) deep = { parent: deep }
    expect(within(root as never, deep as never)).toBe(false)
  })
})

/** A fetch stand-in. Bun's types add `preconnect` to fetch, hence the cast. */
const fakeFetch = (
  run: (...args: Parameters<typeof fetch>) => Promise<Response>,
) => {
  const spy = vi.fn(run)
  return Object.assign(spy as unknown as typeof fetch, { spy })
}

describe('shellApi', () => {
  const answer = (status: number, body: unknown) =>
    fakeFetch(
      async () =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), {
          status,
        }),
    )

  test('posts the view request with the CSRF header and resolves the grant', async () => {
    const fetch = answer(200, grant('h1', 7, 'read'))
    const api = shellApi(fetch, 'https://main.test')
    await expect(api.view({ tree: 't1', path: 'questions/' })).resolves.toEqual(
      grant('h1', 7, 'read'),
    )
    const [url, init] = fetch.spy.mock.calls[0]!
    expect(url).toBe('https://main.test/_/api/view')
    expect(init?.method).toBe('POST')
    expect(init?.credentials).toBe('same-origin')
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      'Dossier-CSRF': '1',
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      tree: 't1',
      path: 'questions/',
    })
  })

  test('rejects an error body with its DossierError', async () => {
    const api = shellApi(
      answer(404, {
        error: {
          code: 'not_found',
          message: 'Not found.',
          fix: null,
          path: 'x',
        },
      }),
      'https://main.test',
    )
    const error = await api.view({ tree: 't1', path: 'x' }).catch((e) => e)
    expect(error).toBeInstanceOf(DossierError)
    expect(error).toMatchObject({
      code: 'not_found',
      message: 'Not found.',
      fix: null,
      path: 'x',
    })
  })

  test('rejects anything else as unavailable', async () => {
    const cases = [
      answer(502, '<html>Bad gateway</html>'),
      answer(400, { error: { code: 'made_up', message: 'No.' } }),
      answer(200, { handle: 'h1' }),
      fakeFetch(async () => {
        throw new TypeError('Failed to fetch')
      }),
    ]
    for (const fetch of cases) {
      const error = await shellApi(fetch, 'https://main.test')
        .view({ tree: 't1', path: '' })
        .catch((e) => e)
      expect(error).toBeInstanceOf(DossierError)
      expect(error.code).toBe('unavailable')
    }
  })
})

describe('createShell', () => {
  test('frames the page in a new element with boot data set before insertion', async () => {
    const it = openShell()
    let atInsertion: { name: string; src: string } | null = null
    const replaceWith = it.placeholder.replaceWith.bind(it.placeholder)
    it.placeholder.replaceWith = (next: Node) => {
      const frame = next as HTMLIFrameElement
      atInsertion = { name: frame.name, src: frame.src }
      replaceWith(next)
    }
    await it.shell.start()

    expect(it.view).toHaveBeenCalledWith({ tree: 't1', path: 'questions/' })
    const frame = it.frame()
    expect(frame).not.toBe(it.placeholder)
    expect(atInsertion).toEqual({ name: frame.name, src: frame.src })
    expect(frame.src).toBe(
      'https://t1-dev.content.test/_/v/h1/7/questions/#intro',
    )
    expect(frame.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-presentation allow-top-navigation-by-user-activation',
    )
    expect(frame.getAttribute('allow')).toBe(
      'fullscreen; clipboard-write; autoplay; picture-in-picture',
    )
    expect(frame.getAttribute('title')).toBe('')
    expect(bootOf(frame)).toEqual({
      v: 1,
      me: { email: 'sara@acme.com', name: 'Sara', role: 'write' },
      drafts: {},
      resume: [],
    })
    it.shell.dispose()
  })

  test('gives a visitor null identity in the boot data', async () => {
    const it = openShell({ boot: { ...BOOT, me: null } })
    await it.shell.start()
    expect(bootOf(it.frame())).toEqual({
      v: 1,
      me: null,
      drafts: {},
      resume: [],
    })
    it.shell.dispose()
  })

  test('welcomes the top page that says hello from its frame', async () => {
    const it = openShell()
    await it.shell.start()
    const { page, shell } = it.hello({ source: it.page() })
    await flush()
    expect(shell.closed).toBe(false)
    expect(page.inbox).toEqual([
      {
        type: 'welcome',
        v: 1,
        me: { email: 'sara@acme.com', name: 'Sara', role: 'write' },
        drafts: {},
        resume: [],
      },
    ])
    it.shell.dispose()
  })

  test.each([
    ['another origin', { origin: 'https://evil.test' }],
    ['another handle', { handle: 'h2' }],
    ['a nested claim from the frame itself', { nested: true }],
  ])('refuses a hello from %s and closes its port', async (_, change) => {
    const it = openShell()
    await it.shell.start()
    const { page, shell } = it.hello({ source: it.page(), ...change })
    await flush()
    expect(shell.closed).toBe(true)
    expect(page.inbox).toEqual([])
    it.shell.dispose()
  })

  test('refuses a hello from a window outside its frame', async () => {
    const it = openShell()
    await it.shell.start()
    it.page()
    const outside = { parent: it.win }
    for (const nested of [false, true]) {
      const { page, shell } = it.hello({ source: outside, nested })
      await flush()
      expect(shell.closed).toBe(true)
      expect(page.inbox).toEqual([])
    }
    it.shell.dispose()
  })

  test('refuses a hello with no port or two ports, closing every one', async () => {
    const it = openShell()
    await it.shell.start()
    const source = it.page()
    const none = it.hello({ source, ports: [] })
    expect(none.ports).toEqual([])
    const two = it.hello({ source, ports: [new FakePort(), new FakePort()] })
    await flush()
    expect(two.ports.every((port) => port.closed)).toBe(true)
    it.shell.dispose()
  })

  test('refuses a top-page hello from a nested window', async () => {
    const it = openShell()
    await it.shell.start()
    const nested = { parent: it.page() }
    const { shell } = it.hello({ source: nested, nested: false })
    expect(shell.closed).toBe(true)
    it.shell.dispose()
  })

  test('welcomes a nested page but follows only the top page', async () => {
    const it = openShell()
    await it.shell.start()
    const top = it.page()
    it.hello({ source: top })
    const nested = it.hello({
      source: { parent: { parent: top } },
      nested: true,
    })
    await flush()
    expect(nested.shell.closed).toBe(false)
    expect(nested.page.inbox).toHaveLength(1)
    nested.page.postMessage({
      type: 'location',
      path: 'elsewhere',
      hash: '',
      title: 'Elsewhere',
    })
    nested.page.postMessage({ type: 'open', path: 'elsewhere', hash: '' })
    await flush()
    expect(it.replaceState).not.toHaveBeenCalled()
    expect(it.pushState).not.toHaveBeenCalled()
    expect(it.view).toHaveBeenCalledTimes(1)
    it.shell.dispose()
  })

  test('follows the top page’s location in the address bar and title', async () => {
    const it = openShell()
    await it.shell.start()
    const { page } = it.hello({ source: it.page() })
    page.postMessage({
      type: 'location',
      path: 'questions/plan',
      hash: '#risks',
      title: 'Plan',
    })
    await flush()
    expect(it.replaceState).toHaveBeenCalledWith(
      null,
      '',
      '/agent964/acme/questions/plan#risks',
    )
    expect(it.win.document.title).toBe('Plan')

    page.postMessage({ type: 'location', path: '', hash: '', title: '' })
    await flush()
    expect(it.replaceState).toHaveBeenLastCalledWith(
      null,
      '',
      '/agent964/acme/',
    )
    expect(it.win.document.title).toBe('Acme Dossier')
    it.shell.dispose()
  })

  test('opens another page in a new element with fresh boot data', async () => {
    const it = openShell({
      grants: [grant('h1', 7, 'write'), grant('h2', 8, 'read')],
    })
    await it.shell.start()
    const first = it.frame()
    const { page, shell } = it.hello({ source: it.page() })
    page.postMessage({ type: 'open', path: 'plan', hash: '#top' })
    await flush()

    expect(it.pushState).toHaveBeenCalledWith(
      null,
      '',
      '/agent964/acme/plan#top',
    )
    expect(it.view).toHaveBeenLastCalledWith({ tree: 't1', path: 'plan' })
    const next = it.frame()
    expect(next).not.toBe(first)
    expect(first.isConnected).toBe(false)
    expect(next.src).toBe('https://t1-dev.content.test/_/v/h2/8/plan#top')
    expect(new URL(next.src).origin).toBe(BOOT.contentOrigin)
    expect(bootOf(next)).toEqual({
      v: 1,
      me: { email: 'sara@acme.com', name: 'Sara', role: 'read' },
      drafts: {},
      resume: [],
    })
    // The previous page's port is closed with it.
    expect(shell.closed).toBe(true)

    // The new page says hello with the new handle; the old one is gone.
    const stale = it.hello({ source: it.page(), handle: 'h1' })
    expect(stale.shell.closed).toBe(true)
    const fresh = it.hello({ source: it.page(), handle: 'h2' })
    await flush()
    expect(fresh.page.inbox).toEqual([
      {
        type: 'welcome',
        v: 1,
        me: { email: 'sara@acme.com', name: 'Sara', role: 'read' },
        drafts: {},
        resume: [],
      },
    ])
    it.shell.dispose()
  })

  test('navigates the top only to http and https URLs', async () => {
    const it = openShell()
    await it.shell.start()
    const { page } = it.hello({ source: it.page() })
    page.postMessage({ type: 'navigate', href: 'https://example.com/a' })
    page.postMessage({ type: 'navigate', href: 'javascript:alert(1)' })
    page.postMessage({ type: 'navigate', href: 'not a url' })
    await flush()
    expect(it.assign).toHaveBeenCalledTimes(1)
    expect(it.assign).toHaveBeenCalledWith('https://example.com/a')
    it.shell.dispose()
  })

  test('loads the page of the address on back and forward', async () => {
    const it = openShell({ grants: [grant('h1', 7), grant('h1', 9)] })
    await it.shell.start()
    const first = it.frame()
    it.win.history.pushState(null, '', '/agent964/acme/plan#x')
    it.win.dispatchEvent(new it.win.PopStateEvent('popstate'))
    await flush()
    expect(it.view).toHaveBeenLastCalledWith({ tree: 't1', path: 'plan' })
    expect(it.frame()).not.toBe(first)
    expect(it.frame().src).toBe('https://t1-dev.content.test/_/v/h1/9/plan#x')

    it.win.history.pushState(null, '', '/agent964/other/plan')
    it.win.dispatchEvent(new it.win.PopStateEvent('popstate'))
    await flush()
    expect(it.reload).toHaveBeenCalledTimes(1)
    it.shell.dispose()
  })

  test.each(['not_found', 'sign_in_required'] as const)(
    'reloads at once when the view is refused with %s',
    async (code) => {
      const refusal = new DossierError({
        code,
        message: 'No.',
        fix: null,
        path: null,
      })
      const it = openShell({ grants: [refusal] })
      await it.shell.start()
      expect(it.reload).toHaveBeenCalledTimes(1)
      expect(it.frame()).toBe(it.placeholder)
      it.shell.dispose()
    },
  )

  test('reloads after a pause when the view fails otherwise', async () => {
    vi.useFakeTimers()
    const failure = new DossierError({
      code: 'unavailable',
      message: 'Down.',
      fix: null,
      path: null,
    })
    const it = openShell({ grants: [failure] })
    await it.shell.start()
    expect(it.reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(RETRY_DELAY)
    expect(it.reload).toHaveBeenCalledTimes(1)
    it.shell.dispose()
  })

  test('keeps the address of a pending navigation when the old page reports late', async () => {
    const it = openShell()
    await it.shell.start()
    const { page } = it.hello({ source: it.page() })
    let refuse: (error: unknown) => void = () => {}
    it.view.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject
        }),
    )
    page.postMessage({ type: 'open', path: 'plan', hash: '' })
    await flush()
    const address = () => it.win.location.pathname + it.win.location.hash
    expect(address()).toBe('/agent964/acme/plan')
    // The old page is still in the frame and reports its own location.
    page.postMessage({
      type: 'location',
      path: 'questions/',
      hash: '#late',
      title: 'Old',
    })
    await flush()
    expect(address()).toBe('/agent964/acme/plan')
    // A refused view reloads at the asked link, which then shows no access.
    refuse(
      new DossierError({
        code: 'not_found',
        message: 'No.',
        fix: null,
        path: null,
      }),
    )
    await flush()
    expect(it.reload).toHaveBeenCalledTimes(1)
    expect(address()).toBe('/agent964/acme/plan')
    it.shell.dispose()
  })

  test('forgets a pending reload once a later load succeeds', async () => {
    vi.useFakeTimers()
    const failure = new DossierError({
      code: 'unavailable',
      message: 'Down.',
      fix: null,
      path: null,
    })
    const it = openShell({ grants: [failure, grant('h1', 9)] })
    await it.shell.start()
    it.win.history.pushState(null, '', '/agent964/acme/plan')
    it.win.dispatchEvent(new it.win.PopStateEvent('popstate'))
    await flush()
    expect(it.frame().src).toBe('https://t1-dev.content.test/_/v/h1/9/plan')
    vi.advanceTimersByTime(RETRY_DELAY * 2)
    expect(it.reload).not.toHaveBeenCalled()
    it.shell.dispose()
  })

  test('renews the handle every hour without reloading the page', async () => {
    vi.useFakeTimers()
    const it = openShell({ grants: [grant('h1', 7), grant('h2', 7)] })
    await it.shell.start()
    const frame = it.frame()
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(it.view).toHaveBeenCalledTimes(2)
    expect(it.view).toHaveBeenLastCalledWith({ tree: 't1', path: 'questions/' })
    expect(it.frame()).toBe(frame)

    // The page in the frame keeps its handle; new pages get the renewed one.
    const source = it.page()
    const old = it.hello({ source, handle: 'h1' })
    await flush()
    expect(old.page.inbox).toHaveLength(1)
    const renewed = it.hello({ source, handle: 'h2' })
    await flush()
    expect(renewed.page.inbox).toHaveLength(1)
    const other = it.hello({ source, handle: 'h3' })
    expect(other.shell.closed).toBe(true)
    it.shell.dispose()
  })

  test('a renewal that a load overtakes leaves the load’s handle', async () => {
    vi.useFakeTimers()
    const it = openShell()
    await it.shell.start()
    const { page } = it.hello({ source: it.page() })
    let answer: (value: ViewGrant) => void = () => {}
    it.view.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    )
    await vi.advanceTimersByTimeAsync(HOUR)
    it.view.mockResolvedValueOnce(grant('h3', 9))
    page.postMessage({ type: 'open', path: 'plan', hash: '' })
    await vi.advanceTimersByTimeAsync(0)
    expect(it.frame().src).toBe('https://t1-dev.content.test/_/v/h3/9/plan')
    answer(grant('h2', 7))
    await vi.advanceTimersByTimeAsync(0)
    const late = it.hello({ source: it.page(), handle: 'h2' })
    expect(late.shell.closed).toBe(true)
    const current = it.hello({ source: it.page(), handle: 'h3' })
    expect(current.shell.closed).toBe(false)
    it.shell.dispose()
  })

  test('renews when the tab shows again after an hour, not sooner', async () => {
    vi.useFakeTimers()
    const it = openShell()
    await it.shell.start()
    const doc = it.win.document
    const visible = vi.spyOn(doc, 'visibilityState', 'get')
    visible.mockReturnValue('visible' as never)
    // Keep the hourly timer out of the way: only the clock moves.
    vi.setSystemTime(Date.now() + HOUR - 1000)
    doc.dispatchEvent(new it.win.Event('visibilitychange'))
    await flush()
    expect(it.view).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 2000)
    doc.dispatchEvent(new it.win.Event('visibilitychange'))
    await flush()
    expect(it.view).toHaveBeenCalledTimes(2)
    it.shell.dispose()
  })

  test('dispose stops listening, renewing and closes the ports', async () => {
    vi.useFakeTimers()
    const it = openShell()
    await it.shell.start()
    const first = it.hello({ source: it.page() })
    it.shell.dispose()
    expect(first.shell.closed).toBe(true)
    const late = it.hello({ source: it.page() })
    await vi.advanceTimersByTimeAsync(HOUR * 2)
    expect(late.page.inbox).toEqual([])
    expect(it.view).toHaveBeenCalledTimes(1)
  })
})

const FORM_A = { host: 'n1', target: 'questions/answers/', id: null }
const FORM_B = { host: 'n1', target: 'questions/board.json', id: 'board' }
const KEY_A = formKey(FORM_A)
const KEY_B = formKey(FORM_B)
const PAGE = 'questions/index.html'

const pendingSend = (
  opId: string,
  by: string | null,
  form: FormRef = FORM_A,
  savedAt = '2026-10-12T10:00:00.000Z',
): PendingSend => ({
  form,
  seq: 7,
  entries: [['name', 'Sara']],
  submitter: null,
  opId,
  page: PAGE,
  by,
  savedAt,
})

const offlineError = () =>
  new DossierError({
    code: 'offline',
    message: 'Not sent. Your answers are kept on this device. Try again.',
    fix: null,
    path: null,
  })

const request = (id: number, send: Partial<SendRequest> = {}) => ({
  type: 'request',
  id,
  op: 'send',
  send: {
    form: FORM_A,
    seq: 7,
    entries: [['name', 'Sara']],
    submitter: null,
    opId: `op-${id}`,
    ...send,
  },
})

describe('shell drafts and sends', () => {
  test('keeps drafts per viewer, tree, page and form', async () => {
    const it = openShell()
    await it.shell.start()
    const top = it.page()
    const { page } = it.hello({ source: top })
    page.postMessage({ type: 'draft', form: KEY_A, values: { name: 'Sa' } })
    page.postMessage({ type: 'draft', form: KEY_B, values: { title: 'Plan' } })
    const nested = it.hello({
      source: { parent: top },
      nested: true,
      path: '/questions/other.html',
    })
    nested.page.postMessage({
      type: 'draft',
      form: KEY_A,
      values: { name: 'Other' },
    })
    await flush()
    expect(it.store.drafts.get(`sara@acme.com|t1|${PAGE}`)).toEqual({
      [KEY_A]: { name: 'Sa' },
      [KEY_B]: { title: 'Plan' },
    })
    expect(
      it.store.drafts.get('sara@acme.com|t1|questions/other.html'),
    ).toEqual({ [KEY_A]: { name: 'Other' } })

    page.postMessage({ type: 'draft', form: KEY_B, values: null })
    await flush()
    expect(it.store.drafts.get(`sara@acme.com|t1|${PAGE}`)).toEqual({
      [KEY_A]: { name: 'Sa' },
    })

    // The next page load and a nested page's welcome carry their own page's.
    page.postMessage({ type: 'open', path: 'questions/', hash: '' })
    await flush()
    expect(bootOf(it.frame())).toMatchObject({
      drafts: { [KEY_A]: { name: 'Sa' } },
    })
    const again = it.hello({ source: it.page() })
    const inner = it.hello({
      source: { parent: it.page() },
      nested: true,
      path: '/questions/other.html',
    })
    await flush()
    expect(again.page.inbox[0]).toMatchObject({
      drafts: { [KEY_A]: { name: 'Sa' } },
    })
    expect(inner.page.inbox[0]).toMatchObject({
      drafts: { [KEY_A]: { name: 'Other' } },
    })
    it.shell.dispose()
  })

  test('a visitor keeps drafts as the empty viewer', async () => {
    const it = openShell({ boot: { ...BOOT, me: null } })
    await it.shell.start()
    const { page } = it.hello({ source: it.page() })
    page.postMessage({ type: 'draft', form: KEY_A, values: { name: 'V' } })
    await flush()
    expect(it.store.drafts.get(`|t1|${PAGE}`)).toEqual({
      [KEY_A]: { name: 'V' },
    })
    it.shell.dispose()
  })

  test('hands a visitor’s drafts in this tree to the person who signs in', async () => {
    const store = memoryStore()
    await store.saveDraft('', 't1', PAGE, KEY_A, { name: 'Before sign-in' })
    await store.saveDraft('', 't2', PAGE, KEY_A, { name: 'Other tree' })
    const adopt = vi.spyOn(store, 'adoptDrafts')
    const it = openShell({ store })
    await it.shell.start()
    expect(bootOf(it.frame())).toMatchObject({
      drafts: { [KEY_A]: { name: 'Before sign-in' } },
    })
    expect(store.drafts.get(`|t1|${PAGE}`)).toBeUndefined()
    expect(store.drafts.get(`|t2|${PAGE}`)).toEqual({
      [KEY_A]: { name: 'Other tree' },
    })
    // Once per shell, not on every load.
    const { page } = it.hello({ source: it.page() })
    page.postMessage({ type: 'open', path: 'plan', hash: '' })
    await flush()
    expect(adopt).toHaveBeenCalledTimes(1)
    it.shell.dispose()
  })

  test('replays kept sends only for the same email or a visitor', async () => {
    const store = memoryStore()
    await store.savePending('t1', PAGE, pendingSend('op-visitor', null))
    await store.savePending(
      't1',
      PAGE,
      pendingSend('op-sara', 'sara@acme.com', FORM_B),
    )
    await store.savePending('t1', PAGE, pendingSend('op-omar', 'omar@acme.com'))
    await store.saveDraft('omar@acme.com', 't1', PAGE, KEY_A, { name: 'Omar' })
    const it = openShell({ store })
    await it.shell.start()
    expect(bootOf(it.frame())).toMatchObject({ resume: [KEY_A, KEY_B] })
    // Another person's send is dropped; their draft stays theirs.
    expect([...store.pending.get(`t1|${PAGE}`)!.keys()]).toEqual([
      'op-visitor',
      'op-sara',
    ])
    expect(store.drafts.get(`omar@acme.com|t1|${PAGE}`)).toEqual({
      [KEY_A]: { name: 'Omar' },
    })
    expect(it.send).not.toHaveBeenCalled()

    const { page } = it.hello({ source: it.page() })
    await flush()
    expect(it.send.mock.calls.map(([payload]) => payload.opId)).toEqual([
      'op-visitor',
      'op-sara',
    ])
    expect(it.send.mock.calls[0]![0]).toEqual({
      tree: 't1',
      page: PAGE,
      seq: 7,
      form: FORM_A,
      entries: [['name', 'Sara']],
      submitter: null,
      entry: null,
      opId: 'op-visitor',
    })
    expect(page.inbox[0]).toMatchObject({
      type: 'welcome',
      resume: [KEY_A, KEY_B],
    })
    expect(page.inbox.slice(1)).toEqual([
      {
        type: 'resumed',
        form: KEY_A,
        ok: true,
        value: { doc: null, replayed: false },
      },
      {
        type: 'resumed',
        form: KEY_B,
        ok: true,
        value: { doc: null, replayed: false },
      },
    ])
    expect(store.pending.get(`t1|${PAGE}`)!.size).toBe(0)
    it.shell.dispose()
  })

  test('replays an offline send on online with the same op ID', async () => {
    const it = openShell()
    await it.shell.start()
    const { page } = it.hello({ source: it.page() })
    await flush()
    page.postMessage({ type: 'draft', form: KEY_A, values: { name: 'Sara' } })
    it.send.mockRejectedValueOnce(offlineError())
    page.postMessage(request(1))
    await flush()
    expect(page.inbox.at(-1)).toEqual({
      type: 'result',
      id: 1,
      ok: false,
      error: {
        code: 'offline',
        message: 'Not sent. Your answers are kept on this device. Try again.',
        fix: null,
        path: null,
      },
    })
    expect(it.store.pending.get(`t1|${PAGE}`)!.get('op-1')).toMatchObject({
      opId: 'op-1',
      page: PAGE,
      by: 'sara@acme.com',
    })

    it.win.dispatchEvent(new it.win.Event('online'))
    await flush()
    expect(it.send).toHaveBeenCalledTimes(2)
    expect(it.send.mock.calls[1]![0].opId).toBe('op-1')
    expect(page.inbox.at(-1)).toEqual({
      type: 'resumed',
      form: KEY_A,
      ok: true,
      value: { doc: null, replayed: false },
    })
    expect(it.store.pending.get(`t1|${PAGE}`)!.size).toBe(0)
    expect(it.store.drafts.get(`sara@acme.com|t1|${PAGE}`)).toEqual({})
    it.shell.dispose()
  })

  test('tries kept sends every 30 seconds while the tab is open', async () => {
    vi.useFakeTimers()
    const it = openShell()
    await it.shell.start()
    const { page } = it.hello({ source: it.page() })
    await flush()
    it.send.mockRejectedValueOnce(offlineError())
    it.send.mockRejectedValueOnce(offlineError())
    page.postMessage(request(1))
    await flush()
    await vi.advanceTimersByTimeAsync(REPLAY_INTERVAL)
    await flush()
    expect(it.send).toHaveBeenCalledTimes(2)
    expect(page.inbox.at(-1)).toMatchObject({ type: 'resumed', ok: false })
    await vi.advanceTimersByTimeAsync(REPLAY_INTERVAL)
    await flush()
    expect(it.send).toHaveBeenCalledTimes(3)
    expect(it.send.mock.calls.map(([payload]) => payload.opId)).toEqual([
      'op-1',
      'op-1',
      'op-1',
    ])
    expect(page.inbox.at(-1)).toMatchObject({ type: 'resumed', ok: true })
    it.shell.dispose()
  })

  test('keeps a send without trying when the browser is offline', async () => {
    const it = openShell()
    await it.shell.start()
    vi.spyOn(it.win.navigator, 'onLine', 'get').mockReturnValue(false)
    const { page } = it.hello({ source: it.page() })
    await flush()
    page.postMessage(request(1))
    await flush()
    expect(it.send).not.toHaveBeenCalled()
    expect(page.inbox.at(-1)).toMatchObject({
      type: 'result',
      id: 1,
      ok: false,
      error: { code: 'offline' },
    })
    expect(it.store.pending.get(`t1|${PAGE}`)!.has('op-1')).toBe(true)
    it.shell.dispose()
  })

  test('a send that needs sign-in is kept and the shell goes to sign-in', async () => {
    const it = openShell({ boot: { ...BOOT, me: null } })
    await it.shell.start()
    const { page } = it.hello({ source: it.page() })
    await flush()
    it.send.mockRejectedValueOnce(
      new DossierError({
        code: 'sign_in_required',
        message: 'Sign in.',
        fix: null,
        path: null,
      }),
    )
    page.postMessage(request(1))
    await flush()
    expect(it.store.pending.get(`t1|${PAGE}`)!.get('op-1')).toMatchObject({
      by: null,
      page: PAGE,
    })
    expect(it.assign).toHaveBeenCalledWith(
      `/_/sign-in?next=${encodeURIComponent('https://main.test/agent964/acme/questions/')}`,
    )
    // The page is not answered: its form stays sending.
    expect(
      page.inbox.filter((m) => (m as { type: string }).type === 'result'),
    ).toEqual([])
    it.shell.dispose()
  })

  test('uploads each file first and sends the stored upload in its place', async () => {
    const it = openShell()
    await it.shell.start()
    const { page } = it.hello({ source: it.page() })
    const file = new File(['%PDF-1'], 'cv.pdf', { type: 'application/pdf' })
    const blank = new File(['x'], 'notes', { type: '' })
    page.postMessage(
      request(1, {
        entries: [
          ['name', 'Sara'],
          ['cv', file],
          ['extra', blank],
        ],
      }),
    )
    await flush()
    await vi.waitFor(() => expect(it.send).toHaveBeenCalled())
    const sha = createHash('sha256').update('%PDF-1').digest('hex')
    expect(it.upload).toHaveBeenCalledTimes(2)
    const [first] = it.upload.mock.calls[0]!
    expect({ ...first, body: undefined }).toEqual({
      tree: 't1',
      page: PAGE,
      seq: 7,
      host: 'n1',
      target: 'questions/answers/',
      id: null,
      field: 'cv',
      name: 'cv.pdf',
      type: 'application/pdf',
      size: 6,
      sha256: sha,
      opId: 'op-1:cv',
      body: undefined,
    })
    expect(it.upload.mock.calls[1]![0]).toMatchObject({
      type: 'application/octet-stream',
      opId: 'op-1:extra',
    })
    expect(it.send.mock.calls[0]![0].entries).toEqual([
      ['name', 'Sara'],
      [
        'cv',
        {
          file: 'files/cv.pdf',
          name: 'cv.pdf',
          size: 6,
          type: 'application/pdf',
        },
      ],
      [
        'extra',
        {
          file: 'files/notes',
          name: 'notes',
          size: 1,
          type: 'application/octet-stream',
        },
      ],
    ])
    await vi.waitFor(() =>
      expect(page.inbox.at(-1)).toMatchObject({
        type: 'result',
        id: 1,
        ok: true,
      }),
    )
    it.shell.dispose()
  })

  test('reads resolve against the page, with ~ for the viewer', async () => {
    const it = openShell()
    await it.shell.start()
    const { page } = it.hello({ source: it.page() })
    const doc = {
      path: 'questions/answers/sara@acme.com.json',
      data: { name: 'Sara' },
      by: 'sara@acme.com',
      at: '2026-10-12T10:00:00.000Z',
      push: 2,
    } as DocWire
    it.read.mockResolvedValueOnce(doc)
    page.postMessage({
      type: 'request',
      id: 1,
      op: 'read',
      path: 'answers/~.json',
    })
    page.postMessage({
      type: 'request',
      id: 2,
      op: 'read',
      path: '../../x.json',
    })
    await flush()
    expect(it.read).toHaveBeenCalledWith({
      tree: 't1',
      path: 'questions/answers/sara@acme.com.json',
    })
    expect(it.read).toHaveBeenCalledTimes(1)
    const results = page.inbox.filter(
      (m) => (m as { type: string }).type === 'result',
    )
    expect(results).toEqual([
      {
        type: 'result',
        id: 2,
        ok: false,
        error: expect.objectContaining({ code: 'not_found' }),
      },
      { type: 'result', id: 1, ok: true, value: doc },
    ])
    it.shell.dispose()
  })

  test('withdraws the resolved path with the page’s op ID', async () => {
    const it = openShell()
    await it.shell.start()
    const { page } = it.hello({ source: it.page() })
    await flush()
    page.postMessage({
      type: 'request',
      id: 4,
      op: 'withdraw',
      path: '/questions/answers/sara@acme.com.json',
      opId: 'w-1',
    })
    await flush()
    expect(it.withdraw).toHaveBeenCalledWith({
      tree: 't1',
      path: 'questions/answers/sara@acme.com.json',
      opId: 'w-1',
    })
    expect(page.inbox.at(-1)).toEqual({
      type: 'result',
      id: 4,
      ok: true,
      value: null,
    })
    it.shell.dispose()
  })

  test('answers no request over a port it refused', async () => {
    const it = openShell()
    await it.shell.start()
    const { page, shell } = it.hello({ source: it.page(), handle: 'nope' })
    expect(shell.closed).toBe(true)
    page.postMessage({ type: 'request', id: 1, op: 'read', path: 'x.json' })
    page.postMessage(request(2))
    await flush()
    expect(it.read).not.toHaveBeenCalled()
    expect(it.send).not.toHaveBeenCalled()
    it.shell.dispose()
  })
})

describe('shellApi data calls', () => {
  const ok = (status: number, body?: unknown) =>
    fakeFetch(
      async () =>
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
        }),
    )
  const doc = {
    path: 'a.json',
    data: { x: 1 },
    by: 'sara@acme.com',
    at: '2026-10-12T10:00:00.000Z',
    push: 1,
  }

  test('read gets a file, null, or a folder’s files', async () => {
    const fetch = ok(200, { file: doc })
    const api = shellApi(fetch, 'https://main.test')
    await expect(api.read({ tree: 't1', path: 'a.json' })).resolves.toEqual(doc)
    const [url, init] = fetch.spy.mock.calls[0]!
    expect(url).toBe('https://main.test/_/api/data/read?tree=t1&path=a.json')
    expect(init?.credentials).toBe('same-origin')
    await expect(
      shellApi(ok(200, { file: null }), 'https://main.test').read({
        tree: 't1',
        path: 'b.json',
      }),
    ).resolves.toBeNull()
    await expect(
      shellApi(ok(200, { files: [doc] }), 'https://main.test').read({
        tree: 't1',
        path: 'answers/',
      }),
    ).resolves.toEqual([doc])
  })

  test('send, upload and withdraw carry the CSRF header', async () => {
    const send = ok(200, { doc, replayed: true })
    const payload = {
      tree: 't1',
      page: PAGE,
      seq: 7,
      form: FORM_A,
      entries: [['name', 'Sara']] as const,
      submitter: null,
      entry: null,
      opId: 'op-1',
    }
    await expect(
      shellApi(send, 'https://main.test').send(payload),
    ).resolves.toEqual({ doc, replayed: true })
    const [sendUrl, sendInit] = send.spy.mock.calls[0]!
    expect(sendUrl).toBe('https://main.test/_/api/data/send')
    expect(sendInit).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'Dossier-CSRF': '1' },
    })
    expect(JSON.parse(String(sendInit?.body))).toEqual(payload)

    const stored = {
      path: 'questions/answers/sara@acme.com/files/cv.pdf',
      file: 'files/cv.pdf',
      name: 'cv.pdf',
      size: 3,
      type: 'application/pdf',
    }
    const upload = ok(201, stored)
    const body = new Blob(['pdf'])
    await expect(
      shellApi(upload, 'https://main.test').upload({
        tree: 't1',
        page: PAGE,
        seq: 7,
        host: 'n1',
        target: 'questions/answers/',
        id: null,
        field: 'cv',
        name: 'cv.pdf',
        type: 'application/pdf',
        size: 3,
        sha256: 'ab',
        opId: 'op-1:cv',
        body,
      }),
    ).resolves.toEqual(stored)
    const [uploadUrl, uploadInit] = upload.spy.mock.calls[0]!
    const query = new URL(String(uploadUrl)).searchParams
    expect(new URL(String(uploadUrl)).pathname).toBe('/_/api/data/upload')
    expect(Object.fromEntries(query)).toEqual({
      tree: 't1',
      page: PAGE,
      seq: '7',
      host: 'n1',
      target: 'questions/answers/',
      field: 'cv',
      name: 'cv.pdf',
      type: 'application/pdf',
      size: '3',
      sha256: 'ab',
      opId: 'op-1:cv',
    })
    expect(uploadInit).toMatchObject({
      method: 'PUT',
      body,
      headers: { 'Dossier-CSRF': '1' },
    })

    const withdraw = ok(204)
    await expect(
      shellApi(withdraw, 'https://main.test').withdraw({
        tree: 't1',
        path: 'a.json',
        opId: 'w-1',
      }),
    ).resolves.toBeUndefined()
    expect(withdraw.spy.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      headers: { 'Dossier-CSRF': '1' },
    })
  })

  test('no answer is offline; a bad answer is unavailable; an error body is its own', async () => {
    const down = fakeFetch(async () => {
      throw new TypeError('Failed to fetch')
    })
    const offline = await shellApi(down, 'https://main.test')
      .read({ tree: 't1', path: 'a.json' })
      .catch((e) => e)
    expect(offline).toBeInstanceOf(DossierError)
    expect(offline).toMatchObject({
      code: 'offline',
      message: 'Not sent. Your answers are kept on this device. Try again.',
    })
    for (const fetch of [ok(502), ok(200, { nope: true })]) {
      const error = await shellApi(fetch, 'https://main.test')
        .withdraw({ tree: 't1', path: 'a.json', opId: 'w' })
        .then(() =>
          shellApi(fetch, 'https://main.test').read({ tree: 't1', path: 'a' }),
        )
        .catch((e) => e)
      expect(error).toMatchObject({ code: 'unavailable' })
    }
    const closed = await shellApi(
      ok(409, {
        error: { code: 'closed', message: 'Closed.', fix: null, path: null },
      }),
      'https://main.test',
    )
      .send({
        tree: 't1',
        page: PAGE,
        seq: 7,
        form: FORM_A,
        entries: [],
        submitter: null,
        entry: null,
        opId: 'x',
      })
      .catch((e) => e)
    expect(closed).toMatchObject({ code: 'closed', message: 'Closed.' })
  })
})
