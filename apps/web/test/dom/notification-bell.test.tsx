import type { DossierNotification } from '@dossier/contracts/bridge'
import axe from 'axe-core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const invalidate = vi.fn(async () => {})
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate }),
}))

const { NotificationBell } =
  await import('../../src/components/notification-bell.tsx')

const note = (
  n: number,
  over: Partial<DossierNotification> = {},
): DossierNotification => ({
  id: `n${n}`,
  type: 'mention',
  team: null,
  actor: { email: 'sara@acme.com', name: 'Sara Haddad', image: null },
  workspace: 'acme',
  tree: 'plans',
  page: { path: 'a/plan.html', title: 'Plan' },
  anchor: 'S-1',
  label: 'Pricing',
  excerpt: 'Can you check the price?',
  link: `https://dossier.test/acme/plans/a/plan#dossier-comment=plan.comments%2F${n}.json&on=S-1`,
  at: new Date(Date.now() - n * 3_600_000).toISOString(),
  read: false,
  agent: false,
  ...over,
})

/** What the API answers: the unread count, and pages by `before`. */
let unread = 0
let pages: Record<
  string,
  { notifications: DossierNotification[]; next: string | null }
> = {}
const calls: { url: string; init: RequestInit | undefined }[] = []
/** Holds a list answer for the page `before` names until it resolves. */
let gate: ((before: string) => Promise<void>) | null = null
/** What marking read answers, when not the usual. */
let readAnswer: { status: number; unread: number } | null = null
/** Holds count answers until it resolves. */
let countGate: (() => Promise<void>) | null = null

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  unread = 0
  pages = {}
  calls.length = 0
  gate = null
  readAnswer = null
  countGate = null
  invalidate.mockClear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ url: input, init })
      const url = new URL(input, 'https://dossier.test')
      if (url.pathname === '/_/api/notifications/read') {
        if (readAnswer !== null) {
          return Response.json(
            { unread: readAnswer.unread },
            { status: readAnswer.status },
          )
        }
        unread = 0
        return Response.json({ unread })
      }
      const before = url.searchParams.get('before') ?? ''
      if (url.searchParams.get('limit') === '0') {
        // The count as it stands when asked, answered when let through.
        const asked = unread
        await countGate?.()
        return Response.json({ notifications: [], next: null, unread: asked })
      }
      await gate?.(before)
      const page =
        url.searchParams.get('limit') === '0'
          ? { notifications: [], next: null }
          : (pages[before] ?? { notifications: [], next: null })
      return Response.json({ ...page, unread })
    }),
  )
  host = document.createElement('div')
  document.body.append(host as never)
  root = createRoot(host as never)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0))
  })

const bell = () => host.querySelector<HTMLButtonElement>('button')!
const panel = () => host.querySelector<HTMLElement>('[role="dialog"]')!
const badge = () => host.querySelector('[data-testid="unread-badge"]')
const rows = () => [...panel().querySelectorAll<HTMLAnchorElement>('a')]
const buttonNamed = (name: string) =>
  [...panel().querySelectorAll('button')].find((b) => b.textContent === name)

const violations = async () =>
  (
    await axe.run(host as never, {
      runOnly: {
        type: 'rule',
        values: [
          'button-name',
          'link-name',
          'aria-valid-attr-value',
          'aria-dialog-name',
          'label-content-name-mismatch',
        ],
      },
      resultTypes: ['violations'],
    })
  ).violations.map((v) => v.id)

describe('the notification bell', () => {
  it('shows the unread count, "9+" past nine, in the name screen readers hear', async () => {
    unread = 3
    act(() => root.render(<NotificationBell />))
    await settle()
    expect(badge()?.textContent).toBe('3')
    expect(bell().textContent).toBe('Notifications, 3 unread3')
    expect(bell().getAttribute('aria-expanded')).toBe('false')
    unread = 12
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await settle()
    expect(badge()?.textContent).toBe('9+')
    expect(bell().textContent).toContain('Notifications, more than 9 unread')
    unread = 0
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await settle()
    expect(badge()).toBeNull()
    expect(await violations()).toEqual([])
  })

  it('opens the list newest first, unread marked, pages older ones, and marks all read', async () => {
    unread = 1
    pages = {
      '': {
        notifications: [
          note(1),
          note(2, { type: 'reply', anchor: null, label: null, read: true }),
        ],
        next: 'c1',
      },
      c1: {
        notifications: [note(30, { team: 'Design', read: true })],
        next: null,
      },
    }
    act(() => root.render(<NotificationBell />))
    await settle()
    expect(panel().hidden).toBe(true)
    act(() => bell().click())
    await settle()
    expect(panel().hidden).toBe(false)
    expect(bell().getAttribute('aria-expanded')).toBe('true')
    expect(rows().map((a) => a.textContent)).toEqual([
      'SUnread: Sara Haddad mentioned youPlan · PricingCan you check the price?1 h ago',
      'SSara Haddad replied to your threadPlanCan you check the price?2 h ago',
    ])
    expect(rows()[0]!.hasAttribute('data-unread')).toBe(true)
    expect(rows()[1]!.hasAttribute('data-unread')).toBe(false)
    expect(rows()[0]!.getAttribute('href')).toBe(note(1).link)
    expect(await violations()).toEqual([])

    act(() => buttonNamed('Show more')!.click())
    await settle()
    expect(rows()).toHaveLength(3)
    expect(rows()[2]!.textContent).toContain('Sara Haddad mentioned Design')
    expect(buttonNamed('Show more')).toBeUndefined()

    await act(async () => buttonNamed('Mark all as read')!.click())
    await settle()
    const read = calls.find((c) => c.url.endsWith('/read'))!
    expect(read.init?.method).toBe('POST')
    expect(new Headers(read.init?.headers).get('Dossier-CSRF')).toBe('1')
    expect(JSON.parse(String(read.init?.body))).toEqual({ all: true })
    expect(rows().some((a) => a.hasAttribute('data-unread'))).toBe(false)
    expect(badge()).toBeNull()
    expect(invalidate).toHaveBeenCalled()
  })

  it('reads one when chosen, says when all is caught up, and closes on Escape with focus back on the bell', async () => {
    unread = 1
    pages = { '': { notifications: [note(1)], next: null } }
    act(() => root.render(<NotificationBell />))
    await settle()
    act(() => bell().click())
    await settle()
    const row = rows()[0]!
    row.addEventListener('click', (event) => event.preventDefault())
    await act(async () => row.click())
    const read = calls.find((c) => c.url.endsWith('/read'))!
    expect(JSON.parse(String(read.init?.body))).toEqual({ ids: ['n1'] })
    expect(read.init?.keepalive).toBe(true)
    expect(badge()).toBeNull()

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    expect(panel().hidden).toBe(true)
    expect(document.activeElement).toBe(bell())

    pages = { '': { notifications: [], next: null } }
    act(() => bell().click())
    await settle()
    expect(panel().textContent).toContain("You're all caught up")
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(panel().hidden).toBe(true)
  })

  /** Holds the list answers for `before` until the returned release runs. */
  const hold = (held: string) => {
    let release = () => {}
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    gate = (before) => (before === held ? waiting : Promise.resolve())
    return () => act(async () => release())
  }

  it('never lets an answer that left before Mark all as read bring rows back unread', async () => {
    unread = 1
    pages = { '': { notifications: [note(1)], next: null } }
    act(() => root.render(<NotificationBell />))
    await settle()
    const release = hold('')
    act(() => bell().click())
    await settle()
    await act(async () => buttonNamed('Mark all as read')!.click())
    await settle()
    await release()
    await settle()
    expect(rows().some((a) => a.hasAttribute('data-unread'))).toBe(false)
    expect(badge()).toBeNull()
  })

  it('never lets a count asked before Mark all as read bring the old count back', async () => {
    unread = 3
    pages = { '': { notifications: [note(1)], next: null } }
    act(() => root.render(<NotificationBell />))
    await settle()
    act(() => bell().click())
    await settle()
    let release = () => {}
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    countGate = () => waiting
    // Asked again on focus, while there are still three.
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await act(async () => buttonNamed('Mark all as read')!.click())
    await settle()
    expect(badge()).toBeNull()
    await act(async () => release())
    await settle()
    expect(badge()).toBeNull()
  })

  it('drops older ones asked for before the first page was read again', async () => {
    pages = {
      '': { notifications: [note(1)], next: 'c1' },
      c1: { notifications: [note(2)], next: null },
    }
    act(() => root.render(<NotificationBell />))
    await settle()
    act(() => bell().click())
    await settle()
    const release = hold('c1')
    act(() => buttonNamed('Show more')!.click())
    await settle()
    // Closed and opened again: a new first page, with its own cursor.
    act(() => bell().click())
    pages[''] = { notifications: [note(0), note(1)], next: 'c2' }
    act(() => bell().click())
    await settle()
    await release()
    await settle()
    expect(rows().map((a) => a.getAttribute('href'))).toEqual([
      note(0).link,
      note(1).link,
    ])
    expect(buttonNamed('Show more')).toBeDefined()
  })

  it('keeps them unread and says so when Mark all as read fails', async () => {
    unread = 2
    pages = { '': { notifications: [note(1), note(2)], next: null } }
    act(() => root.render(<NotificationBell />))
    await settle()
    act(() => bell().click())
    await settle()
    readAnswer = { status: 503, unread: 0 }
    await act(async () => buttonNamed('Mark all as read')!.click())
    await settle()
    expect(rows().every((a) => a.hasAttribute('data-unread'))).toBe(true)
    expect(badge()?.textContent).toBe('2')
    expect(panel().textContent).toContain(
      'Could not mark them as read. Try again.',
    )
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('shows a chosen one read and takes the count Dossier answers', async () => {
    // Dossier counts up to ten: "9+".
    unread = 10
    readAnswer = { status: 200, unread: 10 }
    pages = { '': { notifications: [note(1), note(2)], next: null } }
    act(() => root.render(<NotificationBell />))
    await settle()
    act(() => bell().click())
    await settle()
    const row = rows()[0]!
    row.addEventListener('click', (event) => event.preventDefault())
    await act(async () => row.click())
    await settle()
    expect(badge()?.textContent).toBe('9+')
    expect(rows()[0]!.hasAttribute('data-unread')).toBe(false)
    await act(async () => rows()[0]!.click())
    await settle()
    expect(calls.filter((c) => c.url.endsWith('/read'))).toHaveLength(1)
  })
})
