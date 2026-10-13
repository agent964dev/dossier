import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { HIDE_LIMIT, startKit } from '../src/page-client/kit.ts'
import { PAGE_URL } from './fake-shell.ts'
import { domWindow, flush } from './ports.ts'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const KIT = {
  'acme-card': '../_components/acme-card.js',
  'acme-badge': '../_components/acme-badge.js',
  'dossier-copy': '/_/base/b1/_components/dossier-copy.js',
}

/** A page window, and a loader whose imports the test settles by hand. */
const open = (used: readonly string[] = ['acme-card']) => {
  const win = domWindow(PAGE_URL)
  const imports = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >()
  const load = vi.fn(
    (url: string) =>
      new Promise<unknown>((resolve, reject) => {
        imports.set(url, { resolve: () => resolve({}), reject })
      }),
  )
  const errors = vi.spyOn(win.console, 'error').mockImplementation(() => {})
  const loader = startKit({
    window: win as unknown as Window,
    kit: KIT,
    used,
    load,
  })
  const doc = win.document
  const rules = () =>
    doc
      .querySelector('style[data-dossier-kit]')
      ?.textContent?.split('\n')
      .filter(Boolean) ?? []
  const define = (tag: string) =>
    win.customElements.define(tag, class extends win.HTMLElement {})
  return { win, doc, load, imports, errors, loader, rules, define }
}

const CARD_URL = new URL(KIT['acme-card'], PAGE_URL).href
const BADGE_URL = new URL(KIT['acme-badge'], PAGE_URL).href

describe('the component loader', () => {
  test('imports a used kit tag at once and hides it until it is defined', async () => {
    const page = open()
    expect(page.load).toHaveBeenCalledTimes(1)
    expect(page.load).toHaveBeenCalledWith(CARD_URL)
    expect(page.rules()).toEqual(['acme-card:not(:defined){visibility:hidden}'])
    page.define('acme-card')
    page.imports.get(CARD_URL)?.resolve()
    await flush()
    expect(page.rules()).toEqual([])
  })

  test('shows a used tag after three seconds even if it never defines', async () => {
    const page = open()
    vi.advanceTimersByTime(HIDE_LIMIT - 1)
    expect(page.rules()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(page.rules()).toEqual([])
    expect(HIDE_LIMIT).toBe(3000)
  })

  test('imports a kit tag added later once, hidden the same way', async () => {
    const page = open()
    const badge = () => page.doc.createElement('acme-badge')
    page.doc.body.appendChild(badge())
    await flush()
    expect(page.load).toHaveBeenCalledWith(BADGE_URL)
    expect(page.rules()).toContain(
      'acme-badge:not(:defined){visibility:hidden}',
    )
    const wrapper = page.doc.createElement('div')
    wrapper.appendChild(badge())
    page.doc.body.appendChild(wrapper)
    page.doc.body.appendChild(badge())
    await flush()
    expect(
      page.load.mock.calls.filter(([url]) => url === BADGE_URL),
    ).toHaveLength(1)
    vi.advanceTimersByTime(HIDE_LIMIT)
    expect(page.rules()).toEqual([])
  })

  test('finds a kit tag nested inside an added element', async () => {
    const page = open([])
    const wrapper = page.doc.createElement('section')
    wrapper.innerHTML = '<p><dossier-copy></dossier-copy></p>'
    page.doc.body.appendChild(wrapper)
    await flush()
    expect(page.load).toHaveBeenCalledWith(
      'https://t1-dev.content.test/_/base/b1/_components/dossier-copy.js',
    )
  })

  test('never hides or imports a tag outside the kit', async () => {
    const page = open([])
    page.doc.body.appendChild(page.doc.createElement('other-tag'))
    await flush()
    expect(page.load).not.toHaveBeenCalled()
    expect(page.rules()).toEqual([])
    expect(page.doc.querySelector('style[data-dossier-kit]')?.textContent).toBe(
      '',
    )
  })

  test('shows the tag and logs one line naming the URL when an import fails', async () => {
    const page = open()
    page.imports.get(CARD_URL)?.reject(new Error('404'))
    await flush()
    expect(page.rules()).toEqual([])
    expect(page.errors).toHaveBeenCalledTimes(1)
    expect(page.errors).toHaveBeenCalledWith(
      `Dossier could not load the component ${CARD_URL}`,
    )
  })

  test('stops watching once every kit tag is imported', async () => {
    const page = open(['acme-card', 'acme-badge', 'dossier-copy'])
    expect(page.load).toHaveBeenCalledTimes(3)
    page.doc.body.appendChild(page.doc.createElement('acme-badge'))
    await flush()
    expect(page.load).toHaveBeenCalledTimes(3)
  })
})
