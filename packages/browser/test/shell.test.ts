// MessagePort.postMessage takes no target origin.
// oxlint-disable unicorn/require-post-message-target-origin
import { DossierError } from '@dossier/contracts/bridge'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { shellApi } from '../src/shell/api.ts'
import { RETRY_DELAY, type ViewGrant } from '../src/shell/create-shell.ts'
import { within } from '../src/shell/frames.ts'
import { BOOT, grant, openShell } from './fake-page.ts'
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
    })
    it.shell.dispose()
  })

  test('gives a visitor null identity in the boot data', async () => {
    const it = openShell({ boot: { ...BOOT, me: null } })
    await it.shell.start()
    expect(bootOf(it.frame())).toEqual({ v: 1, me: null })
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
    const renewed = it.hello({ source, handle: 'h2' })
    const other = it.hello({ source, handle: 'h3' })
    await vi.advanceTimersByTimeAsync(0)
    expect(old.page.inbox).toHaveLength(1)
    expect(renewed.page.inbox).toHaveLength(1)
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
