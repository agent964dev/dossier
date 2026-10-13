import { DossierError } from '@dossier/contracts/bridge'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  WELCOME_TIMEOUT,
  createPageClient,
  type Dossier,
} from '../src/page-client/create-page-client.ts'
import { install } from '../src/page-client/install.ts'
import { framePath, linkAction } from '../src/page-client/location.ts'
import {
  BOOTSTRAP,
  CONTENT,
  HANDLE,
  MAIN,
  PAGE_URL,
  SARA,
  openPage,
  type Page,
} from './fake-shell.ts'
import { FakePort, fakeChannel, flush } from './ports.ts'

afterEach(() => {
  vi.useRealTimers()
})

const bootName = (me: unknown) => `dossier-boot:${JSON.stringify({ v: 1, me })}`

const clientOf = (page: Page, port: FakePort = new FakePort()): Dossier =>
  createPageClient({ bootstrap: BOOTSTRAP, port, window: page.window })

/** Installs the page client and returns `window.dossier`. */
const installed = (page: Page): Dossier => {
  install(page.window)
  return (page.win as unknown as { dossier: Dossier }).dossier
}

describe('boot data in the window name', () => {
  test('the top page reads and clears it, and is ready at once', async () => {
    const page = openPage({ placement: 'top', name: bootName(SARA) })
    const dossier = clientOf(page)
    expect(page.win.name).toBe('')
    expect(dossier.me).toEqual(SARA)
    await expect(dossier.ready).resolves.toBeUndefined()
  })

  test('any other name is left alone and ignored', () => {
    const page = openPage({ placement: 'top', name: 'reports' })
    const dossier = clientOf(page)
    expect(page.win.name).toBe('reports')
    expect(dossier.me).toBeNull()
  })

  test('a nested page clears it but never believes it', () => {
    const page = openPage({ placement: 'nested', name: bootName(SARA) })
    const dossier = clientOf(page)
    expect(page.win.name).toBe('')
    expect(dossier.me).toBeNull()
  })

  test('malformed boot data is cleared and ignored', () => {
    const page = openPage({ placement: 'top', name: 'dossier-boot:{nope' })
    const dossier = clientOf(page)
    expect(page.win.name).toBe('')
    expect(dossier.me).toBeNull()
  })
})

describe('install', () => {
  test.each([
    ['top', false],
    ['nested', true],
    ['alone', false],
  ] as const)(
    'marks the page embedded only inside another page (%s)',
    (placement, embedded) => {
      const page = openPage({ placement })
      const dossier = installed(page)
      const html = page.win.document.documentElement
      expect(html.hasAttribute('data-dossier-embedded')).toBe(embedded)
      expect(dossier.page).toEqual({
        path: '/questions/plan.html',
        push: 2,
        embedded,
        exported: false,
      })
    },
  )

  test('says hello to the deployment origin with one port and its handle', () => {
    const page = openPage({ placement: 'top', name: bootName(SARA) })
    installed(page)
    expect(page.shell.hellos).toHaveLength(1)
    const [hello] = page.shell.hellos
    expect(hello!.targetOrigin).toBe(MAIN)
    expect(hello!.ports).toHaveLength(1)
    expect(hello!.ports[0]).toBeInstanceOf(FakePort)
    expect(hello!.data).toEqual({
      dossier: 'hello',
      v: 1,
      handle: HANDLE,
      path: '/questions/plan.html',
      nested: false,
    })
  })

  test('a nested page says hello to the top as nested', () => {
    const page = openPage({ placement: 'nested' })
    installed(page)
    expect(page.shell.hellos).toHaveLength(1)
    expect(page.shell.hellos[0]!.data).toMatchObject({
      handle: HANDLE,
      nested: true,
    })
  })

  test('a page opened on its own says no hello and is ready at once', async () => {
    const page = openPage({ placement: 'alone' })
    const dossier = installed(page)
    expect(page.shell.hellos).toEqual([])
    expect(dossier.me).toBeNull()
    await expect(dossier.ready).resolves.toBeUndefined()
  })

  test('window.dossier cannot be replaced', () => {
    const page = openPage({ placement: 'top', name: bootName(SARA) })
    const dossier = installed(page)
    const descriptor = Object.getOwnPropertyDescriptor(page.win, 'dossier')
    expect(descriptor).toMatchObject({
      value: dossier,
      writable: false,
      configurable: false,
    })
  })
})

describe('ready for a nested page', () => {
  test('resolves on the welcome and takes identity from it', async () => {
    const page = openPage({ placement: 'nested' })
    const dossier = installed(page)
    let settled = false
    void dossier.ready.then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)
    expect(dossier.me).toBeNull()
    page.shell.welcome(SARA)
    await flush()
    expect(settled).toBe(true)
    expect(dossier.me).toEqual(SARA)
  })

  test('ignores a message that is not a welcome', async () => {
    const { port1, port2 } = fakeChannel()
    const page = openPage({ placement: 'nested' })
    const dossier = clientOf(page, port1)
    port2.postMessage({ type: 'welcome', v: 2, me: SARA })
    port2.postMessage({ type: 'welcome', v: 1, me: { email: 'x' } })
    await flush()
    expect(dossier.me).toBeNull()
  })

  test('rejects with unavailable after 10 seconds without a welcome', async () => {
    vi.useFakeTimers()
    const page = openPage({ placement: 'nested' })
    const dossier = installed(page)
    let settled = false
    const outcome = dossier.ready
      .then(
        () => 'resolved',
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true
      })
    await vi.advanceTimersByTimeAsync(WELCOME_TIMEOUT - 1)
    expect(settled).toBe(false)
    expect(page.shell.hellos).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    const error = await outcome
    expect(error).toBeInstanceOf(DossierError)
    expect(error).toMatchObject({ code: 'unavailable', fix: null, path: null })
  })

  test('a welcome before the 10 seconds stops the timer', async () => {
    vi.useFakeTimers()
    const page = openPage({ placement: 'nested' })
    const dossier = installed(page)
    page.shell.welcome(null)
    await vi.advanceTimersByTimeAsync(WELCOME_TIMEOUT * 2)
    await expect(dossier.ready).resolves.toBeUndefined()
  })
})

describe('location and links of the top page', () => {
  const body = `
    <a id="other" href="./other">Other</a>
    <a id="folder" href="../">Up</a>
    <a id="section" href="#section">Section</a>
    <a id="hashed" href="./other#part">Other part</a>
    <a id="main-link" href="${MAIN}/agent964/acme/brief.pdf">Brief</a>
    <a id="main-root" href="${MAIN}/agent964/acme">Root</a>
    <a id="other-tree" href="${MAIN}/agent964/beta/plan">Beta</a>
    <a id="away" href="https://example.com/x">Away</a>
    <a id="blank" href="./other" target="_blank">New tab</a>
    <a id="self" href="./other" target="_self">Self</a>
    <a id="download" href="./other" download>Download</a>
    <a id="mail" href="mailto:sara@acme.com">Mail</a>
    <a id="nested-text" href="./other"><span>Inner</span></a>
    <svg><a id="svg" href="./other"><text>SVG</text></a></svg>
  `

  const topPage = (): Page => {
    const page = openPage({ placement: 'top', name: bootName(SARA), body })
    installed(page)
    return page
  }

  const click = (
    page: Page,
    id: string,
    init: {
      readonly button?: number
      readonly metaKey?: boolean
      readonly ctrlKey?: boolean
      readonly shiftKey?: boolean
      readonly altKey?: boolean
    } = {},
  ): { readonly prevented: boolean } => {
    const target = page.win.document.getElementById(id)!
    const event = new page.win.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      ...init,
    })
    target.dispatchEvent(event)
    return { prevented: event.defaultPrevented }
  }

  const sent = async (page: Page): Promise<unknown[]> => {
    await flush()
    return page.shell
      .received()
      .filter((message) => (message as { type: string }).type !== 'location')
  }

  test('reports its location when it loads and when the hash changes', async () => {
    const page = topPage()
    await flush()
    expect(page.shell.received()).toEqual([
      { type: 'location', path: 'questions/plan', hash: '', title: 'Plan' },
    ])
    page.win.history.replaceState(null, '', '#risks')
    page.win.document.title = 'Plan · risks'
    page.win.dispatchEvent(new page.win.HashChangeEvent('hashchange'))
    await flush()
    expect(page.shell.received().at(-1)).toEqual({
      type: 'location',
      path: 'questions/plan',
      hash: '#risks',
      title: 'Plan · risks',
    })
  })

  test('waits for the document to be parsed before reporting', async () => {
    const page = openPage({ placement: 'top', name: bootName(SARA) })
    const doc = page.win.document
    Object.defineProperty(doc, 'readyState', {
      value: 'loading',
      configurable: true,
    })
    installed(page)
    await flush()
    expect(page.shell.received()).toEqual([])
    doc.dispatchEvent(new page.win.Event('DOMContentLoaded'))
    await flush()
    expect(page.shell.received()).toHaveLength(1)
  })

  test('hands links to other pages of the tree to the shell to open', async () => {
    const page = topPage()
    expect(click(page, 'other').prevented).toBe(true)
    expect(click(page, 'folder').prevented).toBe(true)
    expect(click(page, 'hashed').prevented).toBe(true)
    expect(click(page, 'self').prevented).toBe(true)
    expect(click(page, 'nested-text').prevented).toBe(true)
    expect(click(page, 'main-link').prevented).toBe(true)
    expect(click(page, 'main-root').prevented).toBe(true)
    expect(await sent(page)).toEqual([
      { type: 'open', path: 'questions/other', hash: '' },
      { type: 'open', path: '', hash: '' },
      { type: 'open', path: 'questions/other', hash: '#part' },
      { type: 'open', path: 'questions/other', hash: '' },
      { type: 'open', path: 'questions/other', hash: '' },
      { type: 'open', path: 'brief.pdf', hash: '' },
      { type: 'open', path: '', hash: '' },
    ])
  })

  test('hands links that leave the tree to the shell to navigate', async () => {
    const page = topPage()
    expect(click(page, 'away').prevented).toBe(true)
    expect(click(page, 'other-tree').prevented).toBe(true)
    expect(await sent(page)).toEqual([
      { type: 'navigate', href: 'https://example.com/x' },
      { type: 'navigate', href: `${MAIN}/agent964/beta/plan` },
    ])
  })

  test('follows SVG links too', async () => {
    const page = topPage()
    expect(click(page, 'svg').prevented).toBe(true)
    expect(await sent(page)).toEqual([
      { type: 'open', path: 'questions/other', hash: '' },
    ])
  })

  test('leaves hash links, targets, downloads, modified clicks and other schemes alone', async () => {
    const page = topPage()
    expect(click(page, 'section').prevented).toBe(false)
    expect(click(page, 'blank').prevented).toBe(false)
    expect(click(page, 'download').prevented).toBe(false)
    expect(click(page, 'mail').prevented).toBe(false)
    expect(click(page, 'other', { metaKey: true }).prevented).toBe(false)
    expect(click(page, 'other', { ctrlKey: true }).prevented).toBe(false)
    expect(click(page, 'other', { shiftKey: true }).prevented).toBe(false)
    expect(click(page, 'other', { button: 1 }).prevented).toBe(false)
    expect(await sent(page)).toEqual([])
  })

  test('leaves a click the page already cancelled alone', async () => {
    const page = topPage()
    page.win.document
      .getElementById('other')!
      .addEventListener('click', (event) => event.preventDefault())
    click(page, 'other')
    expect(await sent(page)).toEqual([])
  })

  test('respects a base target', async () => {
    const page = topPage()
    const base = page.win.document.createElement('base')
    base.setAttribute('target', '_blank')
    page.win.document.head.append(base)
    expect(click(page, 'other').prevented).toBe(false)
    expect(await sent(page)).toEqual([])
  })

  test('a nested page leaves its links and location to itself', async () => {
    const page = openPage({ placement: 'nested', body })
    installed(page)
    const event = new page.win.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    page.win.document.getElementById('away')!.dispatchEvent(event)
    await flush()
    expect(event.defaultPrevented).toBe(false)
    expect(page.shell.received()).toEqual([])
  })
})

describe('frame URLs', () => {
  test('framePath splits the handle, sequence and link path', () => {
    expect(framePath('/_/v/h1/3/questions/plan')).toEqual({
      handle: 'h1',
      seq: 3,
      path: 'questions/plan',
    })
    expect(framePath('/_/v/h1/3/')).toEqual({ handle: 'h1', seq: 3, path: '' })
    expect(framePath('/_/v/h1/3')).toEqual({ handle: 'h1', seq: 3, path: '' })
    expect(framePath('/questions/plan')).toBeNull()
  })

  test('a frame URL of this handle at another sequence still opens', () => {
    const page = { location: PAGE_URL, bootstrap: BOOTSTRAP }
    expect(linkAction(`${CONTENT}/_/v/${HANDLE}/9/a%20b`, page)).toEqual({
      type: 'open',
      path: 'a%20b',
      hash: '',
    })
    expect(linkAction(`${CONTENT}/_/v/other/3/plan`, page)).toEqual({
      type: 'navigate',
      href: `${CONTENT}/_/v/other/3/plan`,
    })
  })
})
