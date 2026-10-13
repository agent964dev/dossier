// @vitest-environment happy-dom
import {
  DossierError,
  type CommentDoc,
  type Doc,
  type ErrorCode,
  type JsonObject,
  type Me,
  type Mentionable,
  type Thread,
} from '@dossier/contracts/bridge'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import {
  claimText,
  keptKey,
  LOOKUP_DELAY_MS,
  MARK,
  TEXT,
  type CommentsStateDetail,
} from '../src/base/components/dossier-comments/element.ts'
import {
  mentionsIn,
  pinFromPoint,
  pinPosition,
  placeThreads,
} from '../src/base/components/dossier-comments/threads.ts'
import type { Dossier } from '../src/page-client/create-page-client.ts'

const PAGE = '/a/plan.html'
const FOLDER = 'plan.comments/'
const SARA: Me = { email: 'sara@acme.com', name: 'Sara', role: 'respond' }
const LEE = 'lee@acme.com'
const BOOT = {
  origin: 'https://main.test',
  link: 'https://main.test/acme/plans/a/plan',
}

const keptFor = (text: string, replyTo: string | null = null) => ({
  text,
  anchor: null,
  label: null,
  pin: null,
  replyTo,
  stance: null,
  mentions: [],
})

interface Call {
  readonly op: 'read' | 'watch' | 'unwatch' | 'write' | 'withdraw'
  readonly path: string
  readonly patch?: JsonObject
}

/** The page client the component talks to: records calls, answers reads. */
const peer = {
  me: SARA as Me | null,
  threads: [] as Doc<Thread>[],
  calls: [] as Call[],
  watchers: new Set<(value: readonly Doc<Thread>[]) => void>(),
  /** The next sends reject with these, in order. */
  failures: [] as DossierError[],
  /** Whom Dossier suggests, and what it was asked. */
  mentionable: { people: [], teams: [] } as Mentionable,
  asked: [] as string[],
  reset() {
    this.me = SARA
    this.threads = []
    this.calls = []
    this.watchers.clear()
    this.failures = []
    this.mentionable = { people: [], teams: [] }
    this.asked = []
  },
  /** A change in the folder, as the watch reports it. */
  emit(threads: Doc<Thread>[]) {
    this.threads = threads
    for (const watcher of this.watchers) watcher(threads)
  },
  sends() {
    return this.calls.filter((c) => c.op === 'write' || c.op === 'withdraw')
  },
}

const fake = {
  get me() {
    return peer.me
  },
  page: { path: PAGE, push: 3, embedded: false, exported: false },
  ready: Promise.resolve(),
  read: async (path: string) => {
    peer.calls.push({ op: 'read', path })
    return peer.threads
  },
  watch: (path: string, onChange: (value: readonly Doc<Thread>[]) => void) => {
    peer.calls.push({ op: 'watch', path })
    peer.watchers.add(onChange)
    queueMicrotask(() => onChange(peer.threads))
    return () => {
      peer.calls.push({ op: 'unwatch', path })
      peer.watchers.delete(onChange)
    }
  },
  write: async (path: string, patch: JsonObject) => {
    peer.calls.push({ op: 'write', path, patch })
    const failure = peer.failures.shift()
    if (failure !== undefined) throw failure
    return {
      path: `${FOLDER}${peer.me?.email}/2026-10-12T10-00-00.json`,
      data: patch,
      by: peer.me?.email ?? '',
      at: '2026-10-12T10:00:00.000Z',
      push: 3,
    }
  },
  withdraw: async (path: string) => {
    peer.calls.push({ op: 'withdraw', path })
    const failure = peer.failures.shift()
    if (failure !== undefined) throw failure
  },
  upload: async () => {
    throw new Error('not used')
  },
  mentionable: async (query: string) => {
    peer.asked.push(query)
    return peer.mentionable
  },
} as unknown as Dossier

let minute = 0
const comment = (
  by: string,
  text: string,
  over: Partial<CommentDoc> = {},
): CommentDoc => {
  minute += 1
  const at = new Date(2026, 9, 10, 9, minute)
  return {
    text,
    anchor: null,
    label: null,
    pin: null,
    replyTo: null,
    stance: null,
    mentions: [],
    name: null,
    path: `${FOLDER}${by}/2026-10-10T09-${String(minute).padStart(2, '0')}-00.json`,
    by,
    at: at.toISOString(),
    push: 3,
    edited: false,
    deleted: false,
    ...over,
  }
}

const thread = (
  root: CommentDoc,
  replies: CommentDoc[] = [],
  over: Partial<Thread> = {},
): Doc<Thread> => ({
  path: root.path,
  data: {
    root,
    replies: replies.map((reply) => ({ ...reply, replyTo: root.path })),
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    ...over,
  },
  by: root.by,
  at: root.at,
  push: 3,
})

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0))
}

const mount = async (html = '', attrs = '') => {
  document.body.innerHTML = `${html}<dossier-comments ${attrs}></dossier-comments>`
  await settle()
  return document.querySelector('dossier-comments') as HTMLElement
}

const q = <T extends Element = HTMLElement>(
  root: ParentNode,
  selector: string,
) => root.querySelector(selector) as T

const byKey = (root: ParentNode, key: string) =>
  [...root.querySelectorAll('[data-key]')].find(
    (element) => element.getAttribute('data-key') === key,
  ) as HTMLElement | undefined

const buttonNamed = (root: ParentNode, name: string) =>
  [...root.querySelectorAll('button')].find(
    (b) => b.textContent === name && !b.closest('[hidden]'),
  )

const type = (area: HTMLTextAreaElement, text: string) => {
  area.focus()
  area.value = text
  area.setSelectionRange(text.length, text.length)
  area.dispatchEvent(new Event('input', { bubbles: true }))
}

const key = (target: Element, name: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: name,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  )

const mainComposer = (element: HTMLElement) =>
  q<HTMLFormElement>(
    element,
    '.dossier-comments-composer[data-composer="main"]',
  )

const statusOf = (scope: ParentNode) =>
  q(scope, '.dossier-comments-status').textContent

const threadOf = (element: HTMLElement, root: string) =>
  [...element.querySelectorAll('.dossier-comments-thread')].find(
    (li) => li.getAttribute('data-root') === root,
  ) as HTMLElement

/** A selector list split at its top-level commas. */
const splitList = (list: string): string[] => {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let at = 0; at < list.length; at += 1) {
    const char = list[at]
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(list.slice(start, at).trim())
      start = at + 1
    }
  }
  parts.push(list.slice(start).trim())
  return parts
}

/** Every style rule's selector in a sheet, nested rules included. */
const selectors = (css: string): string[] => {
  const found: string[] = []
  const walk = (text: string) => {
    let depth = 0
    let start = 0
    let open = -1
    for (let at = 0; at < text.length; at += 1) {
      const char = text[at]
      if (char === '{') {
        if (depth === 0) open = at
        depth += 1
      } else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          const prelude = text.slice(start, open).trim()
          if (!prelude.startsWith('@')) found.push(...splitList(prelude))
          walk(text.slice(open + 1, at))
          start = at + 1
        }
      } else if (char === ';' && depth === 0) {
        start = at + 1
      }
    }
  }
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ''))
  return found
}

/** Physical sides a layout that follows dir must not use. */
const PHYSICAL =
  /(?:^|[;{\s])(?:margin|padding|border|inset)-(?:left|right)\s*:|(?:^|[;{\s])(?:left|right)\s*:|float\s*:|text-align\s*:\s*(?:left|right)|(?:^|[;{\s])(?:width|height)\s*:/

const sheet = () =>
  document.querySelector('style[data-dossier-base="dossier-comments"]')
    ?.textContent ?? ''

const navigations: { href: string; target: string }[] = []
const observeNavigation = (event: Event) => {
  const link = (event.target as Element).closest?.('a[target="_top"]')
  if (link === null || link === undefined) return
  navigations.push({
    href: (link as HTMLAnchorElement).href,
    target: link.getAttribute('target') ?? '',
  })
  event.preventDefault()
}

beforeAll(async () => {
  ;(window as unknown as { dossier: Dossier }).dossier = fake
  await import('../src/base/components/dossier-comments.ts')
  document.addEventListener('click', observeNavigation, true)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
  document.documentElement.removeAttribute('dir')
  for (const style of document.head.querySelectorAll('style')) style.remove()
  sessionStorage.clear()
  navigations.length = 0
  peer.reset()
})

describe('<dossier-comments>', () => {
  test('is defined by its module with window.dossier and renders into the page’s own DOM', async () => {
    expect(customElements.get('dossier-comments')).toBeDefined()
    const element = await mount()
    expect(element.shadowRoot).toBeNull()
    expect(element.classList.contains('dossier-comments')).toBe(true)
    for (const part of ['header', 'composer', 'status', 'pins']) {
      expect(element.querySelector(`.dossier-comments-${part}`)).not.toBeNull()
    }
    expect(peer.calls[0]).toEqual({ op: 'watch', path: FOLDER })
    expect(q(element, '.dossier-comments-empty').textContent).toBe(TEXT.empty)
    expect(q(element, '[role="status"]').className).toBe(
      'dossier-comments-status',
    )
  })

  test('renders threads with their replies, every text as text', async () => {
    const root = comment(
      SARA.email,
      'Is <b>this</b> right, @lee@acme.com?\nSecond line',
      {
        edited: true,
        mentions: [LEE],
      },
    )
    const reply = comment(LEE, 'Yes.', { stance: 'agree' })
    peer.threads = [thread(root, [reply])]
    const element = await mount()
    const item = threadOf(element, root.path)
    const comments = item.querySelectorAll('.dossier-comments-comment')
    expect(comments).toHaveLength(2)
    const text = q(comments[0]!, '.dossier-comments-text')
    expect(text.textContent).toBe(root.text)
    expect(text.querySelector('b')).toBeNull()
    expect(q(comments[0]!, '.dossier-comments-avatar').textContent).toBe('s')
    expect(q(comments[0]!, '.dossier-comments-author').textContent).toBe(
      SARA.email,
    )
    const time = q<HTMLTimeElement>(comments[0]!, 'time')
    expect(time.dateTime).toBe(root.at)
    expect(time.textContent).toMatch(/^10 Oct( 2026)?, 09:\d\d$/)
    expect(time.title).toMatch(/^10 October 2026, 09:\d\d$/)
    expect(q(comments[0]!, '.dossier-comments-edited').textContent).toBe(
      'edited',
    )
    const replies = q(item, '.dossier-comments-replies')
    expect(replies.contains(comments[1]!)).toBe(true)
    expect(q(comments[1]!, '.dossier-comments-stance').textContent).toBe(
      'agree',
    )
    expect(q(item, '.dossier-comments-place').textContent).toBe(
      TEXT.onWholePage,
    )
    expect(q(element, '.dossier-comments-count').textContent).toBe('1 open')
  })

  test('orders threads by their anchor’s place, whole-page first, and keeps gone anchors under “On an earlier version”', async () => {
    const pricing = comment(LEE, 'Price?', {
      anchor: 'pricing',
      label: 'Pricing',
    })
    const whole = comment(LEE, 'Overall fine.')
    const intro = comment(LEE, 'Intro?', { anchor: 'intro', label: 'Intro' })
    const old = comment(LEE, 'Old part.', { anchor: 'old', label: 'Old part' })
    peer.threads = [pricing, whole, intro, old].map((c) => thread(c))
    const element = await mount(
      '<section id="intro"><h2>Intro</h2></section><section id="pricing"><h2>Pricing</h2></section>',
    )
    const current = [...q(element, '.dossier-comments-threads').children].map(
      (li) => li.getAttribute('data-root'),
    )
    expect(current).toEqual([whole.path, intro.path, pricing.path])
    const earlier = q<HTMLDetailsElement>(element, '.dossier-comments-earlier')
    expect(earlier.hidden).toBe(false)
    expect(earlier.open).toBe(false)
    expect(q(earlier, 'summary').textContent).toBe(`${TEXT.earlier} (1)`)
    const gone = threadOf(element, old.path)
    expect(earlier.contains(gone)).toBe(true)
    expect(q(gone, '.dossier-comments-place').textContent).toBe('On Old part')
    expect(gone.querySelector('a')).toBeNull()
    const link = q<HTMLAnchorElement>(
      threadOf(element, pricing.path),
      '.dossier-comments-link',
    )
    expect(link.textContent).toBe('On Pricing')
    link.click()
    expect(document.activeElement).toBe(document.getElementById('pricing'))
    // The pure placement agrees.
    const placed = placeThreads(peer.threads, document)
    expect(placed.current.map((p) => p.order)).toEqual([0, 1, 2])
    expect(placed.earlier.map((p) => [p.doc.path, p.anchorFound])).toEqual([
      [old.path, false],
    ])
  })

  test('counts each anchored element’s open threads in data-dossier-comments', async () => {
    const a = comment(LEE, 'One', { anchor: 'pricing' })
    const b = comment(LEE, 'Two', { anchor: 'pricing' })
    const c = comment(LEE, 'Three', { anchor: 'intro' })
    peer.threads = [
      thread(a),
      thread(b),
      thread(c, [], { resolved: true, resolvedBy: LEE }),
    ]
    await mount(
      '<section id="intro"></section><section id="pricing"></section>',
    )
    expect(document.getElementById('pricing')!.getAttribute(MARK)).toBe('2')
    expect(document.getElementById('intro')!.hasAttribute(MARK)).toBe(false)
    peer.emit([thread(a), thread(b, [], { resolved: true })])
    await settle()
    expect(document.getElementById('pricing')!.getAttribute(MARK)).toBe('1')
    document.querySelector('dossier-comments')!.remove()
    expect(document.getElementById('pricing')!.hasAttribute(MARK)).toBe(false)
  })

  test('writes a new comment to the folder with all seven keys, then reads it again', async () => {
    const element = await mount(
      '<section id="pricing" title="Pricing table"><h2>Pricing</h2></section>',
    )
    const states: CommentsStateDetail[] = []
    document.addEventListener('dossier:state', (event) =>
      states.push((event as CustomEvent<CommentsStateDetail>).detail),
    )
    const form = mainComposer(element)
    const on = q<HTMLSelectElement>(form, 'select')
    expect([...on.options].map((o) => [o.value, o.textContent])).toEqual([
      ['', TEXT.wholePage],
      ['pricing', 'Pricing table'],
    ])
    on.value = 'pricing'
    on.dispatchEvent(new Event('change'))
    type(q(form, 'textarea'), '  Too high? @Lee@Acme.com  ')
    peer.calls = []
    q<HTMLButtonElement>(form, 'button[type="submit"]').click()
    await settle()
    const [write, read] = peer.calls
    expect(write).toEqual({
      op: 'write',
      path: FOLDER,
      patch: {
        text: 'Too high? @Lee@Acme.com',
        anchor: 'pricing',
        label: 'Pricing table',
        pin: null,
        replyTo: null,
        stance: null,
        mentions: [LEE],
      },
    })
    expect(Object.keys(write!.patch!).sort()).toEqual([
      'anchor',
      'label',
      'mentions',
      'pin',
      'replyTo',
      'stance',
      'text',
    ])
    expect(read).toEqual({ op: 'read', path: FOLDER })
    expect(states.map((s) => s.state)).toEqual(['saving', 'saved'])
    expect(states[1]!.doc?.data).toEqual(write!.patch)
    expect(q<HTMLTextAreaElement>(form, 'textarea').value).toBe('')
    expect(statusOf(element)).toBe(TEXT.saved)
  })

  test('checks the text before sending: nothing empty, nothing over the limits', async () => {
    const element = await mount()
    const form = mainComposer(element)
    const area = q<HTMLTextAreaElement>(form, 'textarea')
    type(area, '   ')
    q<HTMLButtonElement>(form, 'button[type="submit"]').click()
    await settle()
    expect(statusOf(element)).toBe(TEXT.writeSomething)
    expect(area.getAttribute('aria-invalid')).toBe('true')
    type(area, 'x'.repeat(10_001))
    q<HTMLButtonElement>(form, 'button[type="submit"]').click()
    await settle()
    expect(statusOf(element)).toBe(
      'A comment holds at most 10,000 characters; this one has 10,001.',
    )
    const many = Array.from({ length: 21 }, (_, n) => `@p${n}@acme.com`).join(
      ' ',
    )
    type(area, many)
    q<HTMLButtonElement>(form, 'button[type="submit"]').click()
    await settle()
    expect(statusOf(element)).toBe(TEXT.tooManyMentions)
    expect(peer.sends()).toEqual([])
  })

  test('replies with the thread root’s path and a stance the page offers', async () => {
    const root = comment(LEE, 'Ship it?', { anchor: 'plan', label: 'Plan' })
    peer.threads = [thread(root, [comment(LEE, 'Bump.')])]
    const element = await mount(
      '<section id="plan"><h2>Plan</h2></section>',
      'stances="agree, reopen"',
    )
    const item = threadOf(element, root.path)
    buttonNamed(item, TEXT.reply)!.click()
    await settle()
    const form = q<HTMLFormElement>(item, '.dossier-comments-composer')
    expect(document.activeElement).toBe(q(form, 'textarea'))
    const stance = q<HTMLSelectElement>(form, 'select')
    expect([...stance.options].map((o) => o.value)).toEqual([
      '',
      'agree',
      'reopen',
    ])
    stance.value = 'reopen'
    type(q(form, 'textarea'), 'Not yet.')
    peer.calls = []
    q<HTMLButtonElement>(form, 'button[type="submit"]').click()
    await settle()
    expect(peer.calls[0]).toEqual({
      op: 'write',
      path: FOLDER,
      patch: {
        text: 'Not yet.',
        anchor: 'plan',
        label: 'Plan',
        pin: null,
        replyTo: root.path,
        stance: 'reopen',
        mentions: [],
      },
    })
    expect(peer.calls[1]).toEqual({ op: 'read', path: FOLDER })
    // The composer closes and focus returns to Reply.
    expect(item.querySelector('.dossier-comments-composer')).toBeNull()
    expect(document.activeElement).toBe(byKey(item, `reply:${root.path}`))
  })

  test('resolves and reopens a thread with its mark entries, folding resolved threads', async () => {
    const root = comment(LEE, 'Typo in title')
    peer.threads = [thread(root)]
    const element = await mount()
    buttonNamed(threadOf(element, root.path), TEXT.resolve)!.click()
    await settle()
    expect(peer.sends()).toEqual([
      { op: 'write', path: FOLDER, patch: { resolves: root.path } },
    ])
    peer.emit([thread(root, [], { resolved: true, resolvedBy: SARA.email })])
    await settle()
    expect(threadOf(element, root.path)).toBeUndefined()
    const toggle = byKey(element, 'show-resolved')!
    expect(toggle.textContent).toBe(`${TEXT.showResolved} (1)`)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(q(element, '.dossier-comments-empty').textContent).toBe(
      TEXT.noneOpen,
    )
    toggle.click()
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    const item = threadOf(element, root.path)
    expect(q(item, '.dossier-comments-place').textContent).toContain(
      `Resolved by ${SARA.email}`,
    )
    peer.calls = []
    buttonNamed(item, TEXT.reopen)!.click()
    await settle()
    expect(peer.sends()).toEqual([
      { op: 'write', path: FOLDER, patch: { reopens: root.path } },
    ])
  })

  test('revises and withdraws only its writer’s own comments', async () => {
    const mine = comment(SARA.email, 'My first take')
    const theirs = comment(LEE, 'Their reply')
    peer.threads = [thread(mine, [theirs])]
    const element = await mount()
    const own = element.querySelector('.dossier-comments-comment[data-own]')!
    const other = [
      ...element.querySelectorAll('.dossier-comments-comment'),
    ].find((c) => !c.hasAttribute('data-own'))!
    expect(buttonNamed(other, TEXT.edit)).toBeUndefined()
    expect(buttonNamed(other, TEXT.delete)).toBeUndefined()

    buttonNamed(own, TEXT.edit)!.click()
    const editor = q<HTMLTextAreaElement>(
      element,
      `[data-composer="edit:${mine.path}"] textarea`,
    )
    expect(editor.value).toBe('My first take')
    expect(document.activeElement).toBe(editor)
    type(editor, 'My second take, cc @lee@acme.com')
    peer.calls = []
    buttonNamed(element, TEXT.save)!.click()
    await settle()
    expect(peer.sends()).toEqual([
      {
        op: 'write',
        path: mine.path,
        patch: { text: 'My second take, cc @lee@acme.com', mentions: [LEE] },
      },
    ])
    expect(document.activeElement).toBe(byKey(element, `edit:${mine.path}`))

    peer.calls = []
    byKey(element, `delete:${mine.path}`)!.click()
    expect(peer.sends()).toEqual([])
    const confirm = byKey(element, `confirm-delete:${mine.path}`)!
    expect(document.activeElement).toBe(confirm)
    expect(q(element, '.dossier-comments-confirm').textContent).toBe(
      TEXT.askDelete,
    )
    peer.threads = [
      thread({ ...mine, text: '', deleted: true, edited: false }, [theirs]),
    ]
    confirm.click()
    await settle()
    expect(peer.sends()).toEqual([{ op: 'withdraw', path: mine.path }])
    const item = threadOf(element, mine.path)
    expect(q(item, '.dossier-comments-deleted').textContent).toBe(TEXT.deleted)
    expect(buttonNamed(item, TEXT.edit)).toBeUndefined()
    expect(document.activeElement).toBe(item)
  })

  test.each<[ErrorCode, string, string, boolean]>([
    ['offline', 'Not stored.', TEXT.offline, true],
    ['rate_limited', 'Slow down.', TEXT.rateLimited, false],
    ['forbidden', 'No.', TEXT.forbidden, false],
    [
      'too_large',
      'This page holds at most 500 comments.',
      'This page holds at most 500 comments.',
      false,
    ],
    [
      'invalid',
      'A label holds at most 200 characters.',
      'A label holds at most 200 characters.',
      false,
    ],
    ['unavailable', 'Boom.', TEXT.unavailable, true],
    [
      'sign_in_required',
      'Your session ended. Sign in again.',
      'Your session ended. Sign in again.',
      false,
    ],
  ])(
    'shows %s in the status line and keeps the text',
    async (code, message, shown, retry) => {
      const element = await mount()
      const form = mainComposer(element)
      const area = q<HTMLTextAreaElement>(form, 'textarea')
      type(area, 'Keep me')
      peer.failures.push(
        new DossierError({ code, message, fix: null, path: 'text' }),
      )
      const states: string[] = []
      element.addEventListener('dossier:state', (event) =>
        states.push((event as CustomEvent<CommentsStateDetail>).detail.state),
      )
      q<HTMLButtonElement>(form, 'button[type="submit"]').click()
      await settle()
      expect(statusOf(element)).toBe(shown)
      expect(area.value).toBe('Keep me')
      expect(states).toEqual(['saving', 'failed'])
      expect(peer.sends()).toHaveLength(1)
      expect(area.getAttribute('aria-invalid') === 'true').toBe(
        code === 'invalid',
      )
      const again = byKey(element, 'retry:main')!
      expect(again.hidden).toBe(!retry)
      if (!retry) return
      again.focus()
      again.click()
      await settle()
      expect(peer.sends()).toHaveLength(2)
      expect(statusOf(element)).toBe(TEXT.saved)
      expect(again.hidden).toBe(true)
      expect(document.activeElement).toBe(area)
    },
  )

  test('keeps a visitor’s comment in sessionStorage and sends the top to sign-in', async () => {
    peer.me = null
    const element = await mount(
      `<script type="application/json" id="dossier-bootstrap">${JSON.stringify(BOOT)}</script><figure id="chart"><figcaption>x</figcaption></figure>`,
    )
    const form = mainComposer(element)
    expect(form.hidden).toBe(false)
    expect(q(form, '.dossier-comments-note').textContent).toBe(TEXT.visitor)
    const on = q<HTMLSelectElement>(form, 'select')
    on.value = 'chart'
    on.dispatchEvent(new Event('change'))
    type(q(form, 'textarea'), 'Hello from outside')
    q<HTMLButtonElement>(form, 'button[type="submit"]').click()
    await settle()
    expect(peer.sends()).toEqual([])
    expect(navigations).toEqual([
      {
        href: `https://main.test/_/sign-in?next=${encodeURIComponent(BOOT.link)}`,
        target: '_top',
      },
    ])
    expect(JSON.parse(sessionStorage.getItem(keptKey(PAGE))!)).toEqual({
      text: 'Hello from outside',
      anchor: 'chart',
      label: null,
      pin: null,
      replyTo: null,
      stance: null,
      mentions: [],
      // When the press started the round trip to sign-in.
      keptAt: expect.any(Number),
    })
    expect(element.querySelector('a[target="_top"]')).toBeNull()
    expect(statusOf(element)).toBe(TEXT.signingIn)
  })

  test('sends a comment kept by its own sign-in round trip once, as the person who signed in', async () => {
    peer.me = null
    let element = await mount(
      `<script type="application/json" id="dossier-bootstrap">${JSON.stringify(BOOT)}</script>`,
    )
    type(
      q<HTMLTextAreaElement>(mainComposer(element), 'textarea'),
      'Hello from outside',
    )
    q<HTMLButtonElement>(mainComposer(element), 'button[type="submit"]').click()
    await settle()
    expect(peer.sends()).toEqual([])
    element.remove()
    // Back from sign-in, in the same tab.
    peer.me = SARA
    element = await mount()
    expect(peer.sends()).toEqual([
      {
        op: 'write',
        path: FOLDER,
        patch: {
          text: 'Hello from outside',
          anchor: null,
          label: null,
          pin: null,
          replyTo: null,
          stance: null,
          mentions: [],
        },
      },
    ])
    expect(statusOf(element)).toBe(TEXT.saved)
    expect(sessionStorage.getItem(keptKey(PAGE))).toBeNull()
    // Never again: the round trip is spent.
    element.remove()
    document.body.append(element)
    await settle()
    expect(peer.sends()).toHaveLength(1)
  })

  test('puts a comment kept by the round trip back in the composer when its send fails', async () => {
    sessionStorage.setItem(
      keptKey(PAGE),
      JSON.stringify({ ...keptFor('Lost?'), keptAt: Date.now() }),
    )
    peer.failures.push(
      new DossierError({
        code: 'offline',
        message: 'x',
        fix: null,
        path: null,
      }),
    )
    const element = await mount()
    expect(peer.sends()).toHaveLength(1)
    expect(
      q<HTMLTextAreaElement>(mainComposer(element), 'textarea').value,
    ).toBe('Lost?')
    expect(statusOf(element)).toBe(TEXT.offline)
    expect(sessionStorage.getItem(keptKey(PAGE))).toBeNull()
  })

  test.each([
    ['kept longer ago than its round trip allows', Date.now() - 16 * 60_000],
    ['kept without a round trip of its own', undefined],
  ])(
    'gives a comment %s back to whoever signs in, to send themselves',
    async (_, keptAt) => {
      sessionStorage.setItem(
        keptKey(PAGE),
        JSON.stringify({ ...keptFor('Hello from outside'), keptAt }),
      )
      const element = await mount()
      expect(peer.sends()).toEqual([])
      const area = q<HTMLTextAreaElement>(mainComposer(element), 'textarea')
      expect(area.value).toBe('Hello from outside')
      expect(statusOf(element)).toBe(claimText(SARA.email))
      expect(sessionStorage.getItem(keptKey(PAGE))).toBeNull()
      q<HTMLButtonElement>(
        mainComposer(element),
        'button[type="submit"]',
      ).click()
      await settle()
      expect(peer.sends()).toHaveLength(1)
    },
  )

  test('gives a kept reply back in its thread’s composer', async () => {
    const root = comment(LEE, 'Price?')
    peer.threads = [thread(root)]
    sessionStorage.setItem(
      keptKey(PAGE),
      JSON.stringify({
        text: 'Per truck.',
        anchor: null,
        label: null,
        pin: null,
        replyTo: root.path,
        stance: null,
        mentions: [],
      }),
    )
    const element = await mount()
    expect(peer.sends()).toEqual([])
    const form = q<HTMLFormElement>(
      threadOf(element, root.path),
      '.dossier-comments-composer',
    )
    expect(q<HTMLTextAreaElement>(form, 'textarea').value).toBe('Per truck.')
  })

  test('waits for the threads before giving a kept reply back', async () => {
    const root = comment(LEE, 'Price?')
    sessionStorage.setItem(
      keptKey(PAGE),
      JSON.stringify(keptFor('Per truck.', root.path)),
    )
    // The watch answers only after the page client is ready.
    vi.spyOn(fake, 'watch').mockImplementation((_, onChange) => {
      peer.watchers.add(onChange as never)
      return () => peer.watchers.delete(onChange as never)
    })
    const element = await mount()
    expect(sessionStorage.getItem(keptKey(PAGE))).not.toBeNull()
    peer.emit([thread(root)])
    await settle()
    const form = q<HTMLFormElement>(
      threadOf(element, root.path),
      '.dossier-comments-composer',
    )
    expect(q<HTMLTextAreaElement>(form, 'textarea').value).toBe('Per truck.')
    expect(
      q<HTMLTextAreaElement>(mainComposer(element), 'textarea').value,
    ).toBe('')
    expect(sessionStorage.getItem(keptKey(PAGE))).toBeNull()
  })

  test('keeps each person’s unsent text apart, and a visitor’s apart from both', async () => {
    let element = await mount()
    type(
      q<HTMLTextAreaElement>(mainComposer(element), 'textarea'),
      'Sara’s draft',
    )
    element.remove()
    // Someone else signs in in the same tab.
    peer.me = { email: 'bob@acme.com', name: 'Bob', role: 'respond' }
    element = await mount()
    const text = () =>
      q<HTMLTextAreaElement>(mainComposer(element), 'textarea').value
    expect(text()).toBe('')
    element.remove()
    peer.me = null
    element = await mount()
    expect(text()).toBe('')
    element.remove()
    peer.me = SARA
    element = await mount()
    expect(text()).toBe('Sara’s draft')
  })

  test('drops a visitor’s unsent text once it is kept for sign-in', async () => {
    peer.me = null
    let element = await mount(
      `<script type="application/json" id="dossier-bootstrap">${JSON.stringify(BOOT)}</script>`,
    )
    type(
      q<HTMLTextAreaElement>(mainComposer(element), 'textarea'),
      'Asked once.',
    )
    q<HTMLButtonElement>(mainComposer(element), 'button[type="submit"]').click()
    await settle()
    expect(sessionStorage.getItem(keptKey(PAGE))).not.toBeNull()
    element.remove()
    // Back as a visitor: the kept comment waits, but no draft holds it too.
    sessionStorage.removeItem(keptKey(PAGE))
    element = await mount()
    expect(
      q<HTMLTextAreaElement>(mainComposer(element), 'textarea').value,
    ).toBe('')
  })

  test('turns a point into pin fractions and back', () => {
    const box = new DOMRect(100, 50, 400, 200)
    const pin = pinFromPoint(box, { clientX: 260, clientY: 94 })
    expect(pin).toEqual({ x: 0.4, y: 0.22 })
    expect(pinPosition(box, pin)).toEqual({ left: 160, top: 44 })
    expect(pinFromPoint(box, { clientX: 0, clientY: 900 })).toEqual({
      x: 0,
      y: 1,
    })
  })

  test('places a pin by keyboard alone and sends it with its anchor', async () => {
    const element = await mount(
      '<p>Intro</p><img id="mockup" title="Mockup" alt="">',
    )
    const form = mainComposer(element)
    const pinButton = byKey(form, 'pin-button:main')!
    expect(pinButton.hidden).toBe(false)
    pinButton.click()
    const draft = q<HTMLButtonElement>(
      element,
      'button.dossier-comments-pin-draft',
    )
    expect(document.activeElement).toBe(draft)
    expect(draft.getAttribute('aria-label')).toBe(
      'New pin, 50% across, 50% down on Mockup',
    )
    // Escape leaves without a pin.
    key(draft, 'Escape')
    expect(document.activeElement).toBe(pinButton)
    expect(draft.hidden).toBe(true)
    pinButton.click()
    for (let i = 0; i < 5; i += 1) key(document.activeElement!, 'ArrowRight')
    key(document.activeElement!, 'ArrowUp', { shiftKey: true })
    key(document.activeElement!, 'Enter')
    const area = q<HTMLTextAreaElement>(form, 'textarea')
    expect(document.activeElement).toBe(area)
    expect(q<HTMLSelectElement>(form, 'select').value).toBe('mockup')
    expect(
      byKey(form, 'remove-pin:main')!.parentElement!.textContent,
    ).toContain('Pinned at 60% across, 40% down on Mockup')
    expect(pinButton.textContent).toBe(TEXT.movePin)
    type(area, 'Move this button')
    q<HTMLButtonElement>(form, 'button[type="submit"]').click()
    await settle()
    expect(peer.sends()[0]!.patch).toMatchObject({
      anchor: 'mockup',
      label: 'Mockup',
      pin: { x: 0.6, y: 0.4 },
    })
  })

  test('keeps a pin placed while an earlier comment on the same element is still sending', async () => {
    const element = await mount('<img id="mockup" title="Mockup" alt="">')
    const form = mainComposer(element)
    const select = q<HTMLSelectElement>(form, 'select')
    select.value = 'mockup'
    select.dispatchEvent(new Event('change'))
    let finish: (() => void) | null = null
    const write = fake.write.bind(fake)
    vi.spyOn(fake, 'write').mockImplementationOnce(
      (path: string, patch: JsonObject) =>
        new Promise((resolve) => {
          finish = () => resolve(write(path, patch))
        }) as never,
    )
    const area = q<HTMLTextAreaElement>(form, 'textarea')
    type(area, 'First, on the mockup.')
    q<HTMLButtonElement>(form, 'button[type="submit"]').click()
    await settle()
    // While it goes, a pin is placed for the next comment.
    byKey(form, 'pin-button:main')!.click()
    key(document.activeElement!, 'Enter')
    expect(byKey(form, 'remove-pin:main')!.closest('[hidden]')).toBeNull()
    finish!()
    await settle()
    expect(byKey(form, 'remove-pin:main')!.closest('[hidden]')).toBeNull()
    type(area, 'Second, pinned.')
    q<HTMLButtonElement>(form, 'button[type="submit"]').click()
    await settle()
    expect(peer.sends()[1]!.patch).toMatchObject({
      anchor: 'mockup',
      pin: { x: 0.5, y: 0.5 },
    })
  })

  test('places a pin where the image is tapped', async () => {
    const element = await mount('<img id="shot" alt="">')
    const image = document.getElementById('shot')!
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(100, 50, 400, 200),
    )
    byKey(element, 'pin-button:main')!.click()
    const overlay = q(element, '.dossier-comments-pin-target')
    overlay.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 260,
        clientY: 94,
      }),
    )
    expect(element.querySelector('.dossier-comments-pin-target')).toBeNull()
    type(q(mainComposer(element), 'textarea'), 'Here')
    q<HTMLButtonElement>(mainComposer(element), 'button[type="submit"]').click()
    await settle()
    expect(peer.sends()[0]!.patch).toMatchObject({
      anchor: 'shot',
      pin: { x: 0.4, y: 0.22 },
    })
  })

  test('keeps the placed pin when for is set to nothing', async () => {
    const element = await mount('<img id="shot" alt="">')
    const image = document.getElementById('shot')!
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(100, 50, 400, 200),
    )
    byKey(element, 'pin-button:main')!.click()
    q(element, '.dossier-comments-pin-target').dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 260,
        clientY: 94,
      }),
    )
    element.setAttribute('for', ' ')
    await settle()
    type(q(mainComposer(element), 'textarea'), 'Here')
    q<HTMLButtonElement>(mainComposer(element), 'button[type="submit"]').click()
    await settle()
    expect(peer.sends()[0]!.patch).toMatchObject({
      anchor: 'shot',
      pin: { x: 0.4, y: 0.22 },
    })
  })

  test('draws a numbered, focusable marker per pinned thread at its point, the same in a right-to-left page', async () => {
    document.documentElement.setAttribute('dir', 'rtl')
    const first = comment(LEE, 'Logo', {
      anchor: 'shot',
      label: 'Screen',
      pin: { x: 0.25, y: 0.5 },
    })
    const second = comment(LEE, 'Button', {
      anchor: 'shot',
      label: 'Screen',
      pin: { x: 0.75, y: 1 },
    })
    peer.threads = [thread(first), thread(second)]
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.id === 'shot') return new DOMRect(100, 50, 400, 200)
        if (this.classList.contains('dossier-comments-pins')) {
          return new DOMRect(20, 500, 600, 0)
        }
        return new DOMRect(0, 0, 0, 0)
      },
    )
    const element = await mount('<img id="shot" alt="">')
    const markers = [
      ...element.querySelectorAll<HTMLButtonElement>(
        'button.dossier-comments-pin:not(.dossier-comments-pin-draft)',
      ),
    ]
    expect(markers.map((m) => m.textContent)).toEqual(['1', '2'])
    expect(markers.map((m) => [m.style.left, m.style.top])).toEqual([
      ['180px', '-350px'],
      ['380px', '-250px'],
    ])
    expect(markers[0]!.getAttribute('aria-label')).toBe(
      `Pin 1: on Screen, by ${LEE}`,
    )
    expect(
      q(threadOf(element, second.path), '.dossier-comments-place').textContent,
    ).toContain('Pin 2')
    markers[1]!.click()
    expect(document.activeElement).toBe(threadOf(element, second.path))
    // The page's own markup is untouched apart from the count.
    expect(document.getElementById('shot')!.outerHTML).toBe(
      `<img id="shot" alt="" ${MARK}="2">`,
    )
  })

  test('mirrors with dir="rtl": logical properties only, no direction of its own', async () => {
    document.documentElement.setAttribute('dir', 'rtl')
    peer.threads = [thread(comment(LEE, 'مرحبا'), [comment(SARA.email, 'أهلا')])]
    const element = await mount()
    const css = sheet()
    expect(css).not.toBe('')
    expect(css).not.toMatch(PHYSICAL)
    for (const logical of [
      'padding-inline-start',
      'border-inline-start',
      'padding-inline',
      'margin-block',
      'inline-size',
      'block-size',
    ]) {
      expect(css).toContain(`${logical}:`)
    }
    // No direction of its own: only each piece of text follows its content.
    expect(element.hasAttribute('dir')).toBe(false)
    const directed = [...element.querySelectorAll('[dir]')]
    expect(directed.length).toBeGreaterThan(0)
    for (const part of directed) {
      expect(part.getAttribute('dir')).toBe('auto')
      expect(part.matches('div, ul, li, form, article')).toBe(false)
    }
    expect(q(element, '.dossier-comments-text').getAttribute('dir')).toBe(
      'auto',
    )
    expect(element.querySelector('[style]')).toBeNull()
  })

  test('puts every style rule inside :where( in the base layer, once per page', async () => {
    const author = document.createElement('style')
    author.textContent = '.dossier-comments-thread { color: red }'
    document.head.append(author)
    await mount()
    document.body.append(document.createElement('dossier-comments'))
    const sheets = document.querySelectorAll(
      'style[data-dossier-base="dossier-comments"]',
    )
    expect(sheets).toHaveLength(1)
    const css = sheets[0]!.textContent!
    expect(css.startsWith('@layer dossier{')).toBe(true)
    const list = selectors(css.slice('@layer dossier{'.length, -1))
    expect(list.length).toBeGreaterThan(20)
    for (const selector of list)
      expect(selector.startsWith(':where(')).toBe(true)
    expect(document.head.firstElementChild?.textContent).toBe('@layer dossier;')
    // No colour of its own: only the theme's variables, currentColor and the
    // system colours a pin needs over an image.
    const colours = css.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/gi)
    expect(colours).toBeNull()
  })

  test('works with no attributes: the default anchors and pins, never its own elements', async () => {
    const element = await mount(
      [
        '<section id="s"><h2 id="h">Heading</h2></section>',
        '<ul><li id="l" aria-label="Item">x</li></ul>',
        '<div id="d">not an anchor</div>',
        '<svg id="v" aria-label="Drawing"></svg>',
        '<div id="p" data-pins title="Board"></div>',
      ].join(''),
    )
    const on = q<HTMLSelectElement>(mainComposer(element), 'select')
    expect([...on.options].map((o) => [o.value, o.textContent])).toEqual([
      ['', TEXT.wholePage],
      ['s', 'Heading'],
      ['h', 'Heading'],
      ['l', 'Item'],
      ['v', 'Drawing'],
      ['p', 'Board'],
    ])
    expect(byKey(element, 'pin-button:main')!.hidden).toBe(false)
    expect(
      [...on.options].some((o) => o.value.startsWith('dossier-comments')),
    ).toBe(false)
  })

  test('stops its watch when it leaves the page', async () => {
    const element = await mount()
    expect(peer.watchers.size).toBe(1)
    element.remove()
    expect(peer.calls.at(-1)).toEqual({ op: 'unwatch', path: FOLDER })
    expect(peer.watchers.size).toBe(0)
  })

  test('shows a new comment from the watch within the same turn', async () => {
    const element = await mount()
    const root = comment(LEE, 'Fresh')
    peer.emit([thread(root)])
    expect(threadOf(element, root.path)).toBeDefined()
    expect(q(element, '.dossier-comments-empty').hidden).toBe(true)
  })

  test('offers people who may only read every thread and no way to write', async () => {
    peer.me = { ...SARA, role: 'read' }
    const root = comment(LEE, 'Look', { anchor: null })
    peer.threads = [thread(root)]
    const element = await mount()
    expect(mainComposer(element).hidden).toBe(true)
    const item = threadOf(element, root.path)
    expect(q(item, '.dossier-comments-text').textContent).toBe('Look')
    for (const name of [TEXT.reply, TEXT.resolve, TEXT.reopen]) {
      expect(buttonNamed(item, name)).toBeUndefined()
    }
  })

  test('suggests people from the threads as @ is typed, as a listbox', async () => {
    peer.threads = [
      thread(comment(LEE, 'Hi', { mentions: ['lena@acme.com'] })),
      thread(comment('omar@acme.com', 'Yo')),
    ]
    const element = await mount()
    const area = q<HTMLTextAreaElement>(mainComposer(element), 'textarea')
    const list = q(mainComposer(element), '[role="listbox"]')
    expect(area.getAttribute('aria-controls')).toBe(list.id)
    expect(area.getAttribute('aria-autocomplete')).toBe('list')
    type(area, 'Ask @le')
    expect(list.hidden).toBe(false)
    const options = [...list.querySelectorAll('[role="option"]')]
    expect(options.map((o) => o.getAttribute('data-mention'))).toEqual([
      `@${LEE}`,
      '@lena@acme.com',
    ])
    expect(area.getAttribute('aria-activedescendant')).toBe(options[0]!.id)
    key(area, 'ArrowDown')
    expect(options[1]!.getAttribute('aria-selected')).toBe('true')
    key(area, 'Enter')
    expect(area.value).toBe('Ask @lena@acme.com ')
    expect(list.hidden).toBe(true)
    type(area, 'And @')
    expect(list.hidden).toBe(false)
    key(area, 'Escape')
    expect(list.hidden).toBe(true)
    expect(area.hasAttribute('aria-activedescendant')).toBe(false)
  })

  test('adds Dossier’s people and teams to those in the threads, by name, and mentions a team as @team:', async () => {
    peer.threads = [
      thread(comment(LEE, 'Hi', { name: 'Lee Park', mentions: ['team:Ops'] })),
    ]
    peer.mentionable = {
      people: [
        { email: LEE, name: null, image: null },
        {
          email: 'lena@acme.com',
          name: 'Lena Saleh',
          image: 'https://photos.test/lena.jpg',
        },
      ],
      teams: [{ name: 'Lead Design', members: 3 }],
    }
    const element = await mount()
    // A name shows where the email did, the email on hover.
    const author = q(element, '.dossier-comments-author')
    expect(author.textContent).toBe('Lee Park')
    expect(author.title).toBe(LEE)
    const area = q<HTMLTextAreaElement>(mainComposer(element), 'textarea')
    const list = q(mainComposer(element), '[role="listbox"]')
    type(area, 'Ask @le')
    // The threads' people at once; Dossier's once typing rests.
    const mentions = () =>
      [...list.querySelectorAll('[role="option"]')].map((o) =>
        o.getAttribute('data-mention'),
      )
    expect(mentions()).toEqual([`@${LEE}`])
    await new Promise((r) => setTimeout(r, LOOKUP_DELAY_MS + 20))
    await settle()
    expect(peer.asked).toEqual(['le'])
    expect(mentions()).toEqual([
      `@${LEE}`,
      '@lena@acme.com',
      '@team:"Lead Design"',
    ])
    const options = [...list.querySelectorAll('[role="option"]')]
    expect(
      options.map((o) => q(o, '.dossier-comments-suggestion-name').textContent),
    ).toEqual(['Lee Park', 'Lena Saleh', 'Lead Design'])
    expect(q<HTMLImageElement>(options[1]!, 'img').src).toBe(
      'https://photos.test/lena.jpg',
    )
    expect(
      q(options[2]!, '.dossier-comments-suggestion-detail').textContent,
    ).toBe('Team · 3 people')
    key(area, 'ArrowUp')
    key(area, 'Enter')
    expect(area.value).toBe('Ask @team:"Lead Design" ')
    // The same @ again is answered from what Dossier already said.
    type(area, 'Ask @team:"Lead Design" and @le')
    expect(mentions()).toHaveLength(3)
    expect(peer.asked).toEqual(['le'])
    type(area, 'Ask @team:"Lead Design" and @lena@acme.com')
    buttonNamed(element, TEXT.comment)!.click()
    await settle()
    expect(peer.sends()[0]?.patch?.mentions).toEqual([
      'team:Lead Design',
      'lena@acme.com',
    ])
  })

  test('never asks Dossier whom to suggest for a visitor', async () => {
    peer.me = null
    peer.threads = [thread(comment(LEE, 'Hi'))]
    const element = await mount()
    const area = q<HTMLTextAreaElement>(mainComposer(element), 'textarea')
    type(area, '@le')
    await new Promise((r) => setTimeout(r, LOOKUP_DELAY_MS + 20))
    await settle()
    expect(peer.asked).toEqual([])
    const list = q(mainComposer(element), '[role="listbox"]')
    expect(list.querySelectorAll('[role="option"]')).toHaveLength(1)
  })

  test('reads emails and teams, bare or quoted, as mentions', () => {
    expect(
      mentionsIn(
        'cc @Lee@Acme.com, @team:Design. @team:"Design Ops" @team:"Say \\"hi\\"" @team:design and @team:"" a@b.c',
      ),
    ).toEqual([
      'lee@acme.com',
      'team:Design',
      'team:Design Ops',
      'team:Say "hi"',
    ])
  })

  test('keeps focus and the caret in place when the threads change', async () => {
    const other = comment(LEE, 'Other')
    const root = comment(LEE, 'First')
    const more = comment(LEE, 'More')
    peer.threads = [thread(other), thread(root)]
    const element = await mount('<section id="later"></section>')
    const order = () =>
      [...q(element, '.dossier-comments-threads').children].map((li) =>
        li.getAttribute('data-root'),
      )
    expect(order()).toEqual([other.path, root.path])
    buttonNamed(threadOf(element, root.path), TEXT.reply)!.click()
    const area = q<HTMLTextAreaElement>(
      threadOf(element, root.path),
      'textarea',
    )
    type(area, 'Halfway there')
    area.setSelectionRange(4, 7)
    // The other thread moves onto a section, so this one moves first.
    peer.emit([thread({ ...other, anchor: 'later' }), thread(root, [more])])
    expect(order()).toEqual([root.path, other.path])
    expect(document.activeElement).toBe(area)
    expect([area.selectionStart, area.selectionEnd]).toEqual([4, 7])
    expect(area.value).toBe('Halfway there')
    // A control rebuilt with its thread keeps focus by what it does.
    const resolve = byKey(element, `resolve:${root.path}`)!
    resolve.focus()
    peer.emit([thread(other), thread(root, [more, comment(LEE, 'Again')])])
    const rebuilt = byKey(element, `resolve:${root.path}`)!
    expect(rebuilt).not.toBe(resolve)
    expect(document.activeElement).toBe(rebuilt)
  })
})

describe('what stays on this device, and who may change what', () => {
  test('keeps the new comment’s unsent text through a failed send and a reload, and drops it once sent', async () => {
    let element = await mount()
    type(q<HTMLTextAreaElement>(mainComposer(element), 'textarea'), 'Kept?')
    peer.failures.push(
      new DossierError({
        code: 'offline',
        message: 'Not sent. Your answers are kept on this device. Try again.',
        fix: null,
        path: null,
      }),
    )
    buttonNamed(mainComposer(element), TEXT.comment)!.click()
    await settle()
    expect(statusOf(element)).toContain(TEXT.offline)
    // A reload of the page: a new element finds the text.
    element.remove()
    element = await mount()
    expect(
      q<HTMLTextAreaElement>(mainComposer(element), 'textarea').value,
    ).toBe('Kept?')
    buttonNamed(mainComposer(element), TEXT.comment)!.click()
    await settle()
    expect(peer.sends()).toHaveLength(2)
    element.remove()
    element = await mount()
    expect(
      q<HTMLTextAreaElement>(mainComposer(element), 'textarea').value,
    ).toBe('')
  })

  test('lets someone who may now only read delete their own comment, never edit it', async () => {
    const mine = comment(SARA.email, 'Mine.')
    peer.threads = [thread(mine)]
    peer.me = { ...SARA, role: 'read' }
    const element = await mount()
    const item = threadOf(element, mine.path)
    expect(buttonNamed(item, TEXT.delete)).toBeDefined()
    expect(buttonNamed(item, TEXT.edit)).toBeUndefined()
    expect(mainComposer(element).hidden).toBe(true)
  })
})

describe('changes that cross each other', () => {
  test('sends a resolve pressed while a reply to the thread is still sending, after it', async () => {
    const root = comment(LEE, 'Price?')
    peer.threads = [thread(root)]
    const element = await mount()
    let finish: (() => void) | null = null
    const write = fake.write.bind(fake)
    const spy = vi.spyOn(fake, 'write').mockImplementationOnce(
      (path: string, patch: JsonObject) =>
        new Promise((resolve) => {
          finish = () => resolve(write(path, patch))
        }) as never,
    )
    const item = threadOf(element, root.path)
    buttonNamed(item, TEXT.reply)!.click()
    await settle()
    const form = q<HTMLFormElement>(item, '.dossier-comments-composer')
    type(q<HTMLTextAreaElement>(form, 'textarea'), 'Per truck.')
    q<HTMLButtonElement>(form, 'button[type="submit"]').click()
    await settle()
    buttonNamed(threadOf(element, root.path), TEXT.resolve)!.click()
    await settle()
    // Only the reply has gone; the resolve waits for its answer.
    expect(spy).toHaveBeenCalledTimes(1)
    finish!()
    await settle()
    expect(peer.sends().map((s) => s.patch)).toEqual([
      expect.objectContaining({ text: 'Per truck.', replyTo: root.path }),
      { resolves: root.path },
    ])
  })

  test('never lets a watch value from before a read replace what the read brought', async () => {
    const root = comment(LEE, 'Price?')
    peer.threads = [thread(root)]
    const element = await mount()
    const older = [thread(root)]
    // The read after a resolve brings the resolved thread, slowly.
    let answer: (() => void) | null = null
    vi.spyOn(fake, 'read').mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = () =>
            resolve([
              thread(root, [], {
                resolved: true,
                resolvedBy: SARA.email,
                resolvedAt: root.at,
              }),
            ] as never)
        }) as never,
    )
    buttonNamed(threadOf(element, root.path), TEXT.resolve)!.click()
    await settle()
    // A watch value read before the resolve lands while the read is out.
    for (const watcher of peer.watchers) watcher(older)
    answer!()
    await settle()
    answer!()
    await settle()
    const toggle = byKey(element, 'show-resolved')!
    expect(toggle.hidden).toBe(false)
    expect(toggle.textContent).toBe(`${TEXT.showResolved} (1)`)
  })
})

describe('anchor labels', () => {
  test('names an element by its title, aria-label, an image’s alt, then its first heading', async () => {
    const element = await mount(
      `<section id="a" title="Titled"><h2>Heading A</h2></section>
       <section id="b" aria-label="Labelled"><h2>Heading B</h2></section>
       <img id="c" alt="Dashboard mockup">
       <section id="d"><h3>Heading D</h3></section>
       <figure id="e"><p>No name</p></figure>`,
    )
    const options = [
      ...q<HTMLSelectElement>(mainComposer(element), 'select').options,
    ].map((o) => [o.value, o.textContent])
    expect(options).toEqual([
      ['', TEXT.wholePage],
      ['a', 'Titled'],
      ['b', 'Labelled'],
      ['c', 'Dashboard mockup'],
      ['d', 'Heading D'],
      ['e', '#e'],
    ])
  })
})

describe('stances on a new comment', () => {
  test('offers the page’s stances on a new comment, and nothing without them', async () => {
    let element = await mount('', 'stances="reopen, for the agent"')
    const form = mainComposer(element)
    const stance = byKey(form, 'stance:main') as HTMLSelectElement
    expect([...stance.options].map((o) => o.value)).toEqual([
      '',
      'reopen',
      'for the agent',
    ])
    stance.value = 'for the agent'
    type(q(form, 'textarea'), 'Hand this over.')
    peer.calls = []
    q<HTMLButtonElement>(form, 'button[type="submit"]').click()
    await settle()
    expect(peer.calls[0]?.patch).toMatchObject({
      text: 'Hand this over.',
      replyTo: null,
      stance: 'for the agent',
    })
    // Sent: the choice goes back to none with the text.
    expect(stance.value).toBe('')
    element.remove()
    element = await mount()
    expect(byKey(mainComposer(element), 'stance:main')).toBeUndefined()
  })
})

describe('with for: the comments on one item', () => {
  const PAGE_HTML =
    '<section id="S-1" title="Step one"></section><section id="S-2"></section>'

  /** A whole-page element, then one under each item. */
  const mountItems = async (attrs = '') => {
    document.body.innerHTML = `${PAGE_HTML}
      <dossier-comments ${attrs}></dossier-comments>
      <dossier-comments for="S-1" ${attrs}></dossier-comments>
      <dossier-comments for="S-2" ${attrs}></dossier-comments>`
    await settle()
    const [page, one, two] = document.querySelectorAll('dossier-comments')
    return {
      page: page as HTMLElement,
      one: one as HTMLElement,
      two: two as HTMLElement,
    }
  }

  const rootsIn = (element: HTMLElement) =>
    [...element.querySelectorAll('.dossier-comments-thread')].map((li) =>
      li.getAttribute('data-root'),
    )

  test('shows only its item’s threads, folded to a Comment button with a count, and the page’s element shows them all', async () => {
    const a = comment(LEE, 'First', { anchor: 'S-1' })
    const b = comment(LEE, 'Second', { anchor: 'S-2' })
    const done = comment(LEE, 'Done', { anchor: 'S-1' })
    const whole = comment(LEE, 'Whole page')
    peer.threads = [
      thread(a),
      thread(b),
      thread(done, [], { resolved: true }),
      thread(whole),
    ]
    const { page, one, two } = await mountItems()
    // One watch for the folder, however many elements show it.
    expect(peer.calls.filter((c) => c.op === 'watch')).toHaveLength(1)
    expect(rootsIn(page)).toEqual([whole.path, a.path, b.path])
    expect(one.classList.contains('dossier-comments-item')).toBe(true)
    expect(page.classList.contains('dossier-comments-item')).toBe(false)
    // Folded: its button and count, and nothing more is even built.
    const opener = byKey(one, 'open')!
    expect(opener.hidden).toBe(false)
    expect(opener.getAttribute('aria-expanded')).toBe('false')
    expect(opener.textContent).toBe('Comment1 open')
    expect(q(one, '.dossier-comments-title').hidden).toBe(true)
    expect(one.querySelector('.dossier-comments-threads')).toBeNull()
    expect(mainComposer(one)).toBeNull()
    expect(byKey(page, 'open')!.hidden).toBe(true)
    // Its item's mark counts its open threads, as the page's element does.
    expect(document.getElementById('S-1')!.getAttribute(MARK)).toBe('1')
    opener.click()
    byKey(two, 'open')!.click()
    await settle()
    expect(rootsIn(one)).toEqual([a.path])
    expect(rootsIn(two)).toEqual([b.path])
    expect(opener.getAttribute('aria-expanded')).toBe('true')
    expect(q(one, '.dossier-comments-threads').hidden).toBe(false)
    expect(mainComposer(one).hidden).toBe(false)
    // No place picker, no pins: it comments on its item.
    expect(byKey(mainComposer(one), 'on:main')!.closest('label')!.hidden).toBe(
      true,
    )
    expect(byKey(one, 'pin-button:main')!.hidden).toBe(true)
    expect(one.querySelector('.dossier-comments-place')).toBeNull()
  })

  /** A page with an element under each of `count` items, and one for it all. */
  const mountMany = async (count: number) => {
    const ids = Array.from({ length: count }, (_, at) => `I-${at}`)
    document.body.innerHTML = `${ids
      .map(
        (id) =>
          `<section id="${id}"><h2>Item ${id}</h2><dossier-comments for="${id}"></dossier-comments></section>`,
      )
      .join('')}<img id="shot" alt="Shot"><dossier-comments></dossier-comments>`
    await settle()
  }

  /** Document-wide lookups and reads of the layout while `run` goes. */
  const costOf = async (run: () => void | Promise<void>) => {
    const queries = vi.spyOn(document, 'querySelectorAll')
    const boxes = vi.spyOn(window.Element.prototype, 'getBoundingClientRect')
    await run()
    await settle()
    const cost = {
      queries: queries.mock.calls.length,
      boxes: boxes.mock.calls.length,
    }
    queries.mockRestore()
    boxes.mockRestore()
    return cost
  }

  test('does the same page-wide work on a delivery however many items have an element', async () => {
    const delivery = async (count: number) => {
      await mountMany(count)
      const one = comment(LEE, 'On one', { anchor: 'I-1' })
      const five = comment(LEE, 'On five', { anchor: 'I-5' })
      return costOf(() => peer.emit([thread(one), thread(five)]))
    }
    const few = await delivery(10)
    document.body.replaceChildren()
    const many = await delivery(60)
    expect(many).toEqual(few)
    // No element read the layout: nothing is pinned.
    expect(many.boxes).toBe(0)
    // Every item is marked, and the folded elements built only their button.
    expect(document.getElementById('I-5')!.getAttribute(MARK)).toBe('1')
    expect(
      document.querySelectorAll('dossier-comments[for] textarea'),
    ).toHaveLength(0)
    expect(
      document.querySelectorAll('dossier-comments[for] .dossier-comments-open'),
    ).toHaveLength(60)
  })

  test('types into an item’s composer without looking through the page', async () => {
    // With nothing pinned, no element follows the page's scrolls and keys.
    const listens = vi.spyOn(document, 'addEventListener')
    await mountMany(30)
    expect(
      listens.mock.calls.filter(([kind]) =>
        ['scroll', 'keydown', 'load', 'toggle'].includes(kind),
      ),
    ).toEqual([])
    listens.mockRestore()
    const element = document.querySelector<HTMLElement>(
      'dossier-comments[for="I-3"]',
    )!
    byKey(element, 'open')!.click()
    await settle()
    const area = q<HTMLTextAreaElement>(mainComposer(element), 'textarea')
    const cost = await costOf(() => {
      for (const text of ['A', 'An', 'Ano', 'Anot', 'Anote']) type(area, text)
    })
    expect(cost).toEqual({ queries: 0, boxes: 0 })
    expect(area.value).toBe('Anote')
  })

  test('leaves an item’s mark to the element still counting it when the other leaves', async () => {
    peer.threads = [thread(comment(LEE, 'First', { anchor: 'S-1' }))]
    const { page, one } = await mountItems()
    const item = document.getElementById('S-1')!
    one.remove()
    expect(item.getAttribute(MARK)).toBe('1')
    page.remove()
    expect(item.hasAttribute(MARK)).toBe(false)
  })

  test('leaves an item’s mark to the element still counting it when the other moves to another item', async () => {
    peer.threads = [thread(comment(LEE, 'First', { anchor: 'S-1' }))]
    const { one } = await mountItems()
    const item = document.getElementById('S-1')!
    one.setAttribute('for', 'S-2')
    await settle()
    expect(item.getAttribute(MARK)).toBe('1')
  })

  test('takes the new item’s own unsent text when for changes', async () => {
    const { one } = await mountItems()
    byKey(one, 'open')!.click()
    await settle()
    const area = q<HTMLTextAreaElement>(mainComposer(one), 'textarea')
    type(area, 'About one')
    one.setAttribute('for', 'S-2')
    expect(area.value).toBe('')
    type(area, 'About two')
    one.setAttribute('for', 'S-1')
    expect(area.value).toBe('About one')
  })

  test('takes the new item’s own unsent text when for changes while it is away', async () => {
    const { one } = await mountItems()
    byKey(one, 'open')!.click()
    await settle()
    const area = q<HTMLTextAreaElement>(mainComposer(one), 'textarea')
    type(area, 'About one')
    one.remove()
    one.setAttribute('for', 'S-2')
    document.body.append(one)
    await settle()
    expect(area.value).toBe('')
    type(area, 'About two')
    peer.calls = []
    q<HTMLButtonElement>(mainComposer(one), 'button[type="submit"]').click()
    await settle()
    expect(peer.calls[0]?.patch).toMatchObject({
      text: 'About two',
      anchor: 'S-2',
    })
  })

  test('keeps unsent text storage refuses, for when for comes back to its item', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const { one } = await mountItems()
    byKey(one, 'open')!.click()
    await settle()
    const area = q<HTMLTextAreaElement>(mainComposer(one), 'textarea')
    type(area, 'About one')
    one.setAttribute('for', 'S-2')
    expect(area.value).toBe('')
    one.setAttribute('for', 'S-1')
    expect(area.value).toBe('About one')
  })

  test('an element that joins the folder’s watch never takes its older value after a newer one', async () => {
    const a = comment(LEE, 'First', { anchor: 'S-1' })
    peer.threads = [thread(a)]
    await mountItems()
    const late = document.createElement('dossier-comments')
    document.body.append(late)
    // The newer value comes before the one the late element was queued.
    const b = comment(LEE, 'Second', { anchor: 'S-2' })
    peer.emit([thread(a), thread(b)])
    await settle()
    expect(rootsIn(late)).toEqual([a.path, b.path])
  })

  test('keeps an edit’s unsaved text on a thread for leaves, for when it comes back', async () => {
    const mine = comment(SARA.email, 'First take', { anchor: 'S-1' })
    peer.threads = [thread(mine)]
    const { one } = await mountItems()
    byKey(one, 'open')!.click()
    await settle()
    byKey(one, `edit:${mine.path}`)!.click()
    const editor = () =>
      one.querySelector<HTMLTextAreaElement>(
        `[data-composer="edit:${mine.path}"] textarea`,
      )
    type(editor()!, 'Second take')
    one.setAttribute('for', 'S-2')
    await settle()
    expect(editor()).toBeNull()
    one.setAttribute('for', 'S-1')
    await settle()
    expect(editor()?.value).toBe('Second take')
  })

  test('keeps a thread’s failed send in its status line when for leaves and comes back', async () => {
    const a = comment(LEE, 'First', { anchor: 'S-1' })
    peer.threads = [thread(a)]
    const { one } = await mountItems()
    byKey(one, 'open')!.click()
    await settle()
    peer.failures.push(
      new DossierError({
        code: 'offline',
        message: 'Not sent. Try again.',
        fix: null,
        path: null,
      }),
    )
    byKey(one, `resolve:${a.path}`)!.click()
    await settle()
    const said = statusOf(threadOf(one, a.path))
    expect(said).not.toBe('')
    one.setAttribute('for', 'S-2')
    await settle()
    one.setAttribute('for', 'S-1')
    await settle()
    expect(statusOf(threadOf(one, a.path))).toBe(said)
  })

  test('keeps the whole page’s placed pin while for names an item, and gives it back', async () => {
    document.body.innerHTML = `${PAGE_HTML}<img id="mockup" title="Mockup" alt="">
      <dossier-comments></dossier-comments>`
    await settle()
    const element = document.querySelector('dossier-comments') as HTMLElement
    const form = mainComposer(element)
    byKey(form, 'pin-button:main')!.click()
    key(document.activeElement!, 'Enter')
    type(q(form, 'textarea'), 'Move this')
    element.setAttribute('for', 'S-1')
    await settle()
    element.removeAttribute('for')
    await settle()
    expect(q<HTMLTextAreaElement>(form, 'textarea').value).toBe('Move this')
    const note = byKey(form, 'remove-pin:main')!.parentElement!
    expect(note.hidden).toBe(false)
    expect(note.textContent).toContain(
      'Pinned at 50% across, 50% down on Mockup',
    )
    peer.calls = []
    q<HTMLButtonElement>(form, 'button[type="submit"]').click()
    await settle()
    expect(peer.sends()[0]!.patch).toMatchObject({
      anchor: 'mockup',
      pin: { x: 0.5, y: 0.5 },
    })
  })

  test('gives back no pin a comment took when it was sent while for named an item', async () => {
    document.body.innerHTML = `${PAGE_HTML}<img id="mockup" title="Mockup" alt="">
      <dossier-comments></dossier-comments>`
    await settle()
    const element = document.querySelector('dossier-comments') as HTMLElement
    const form = mainComposer(element)
    byKey(form, 'pin-button:main')!.click()
    key(document.activeElement!, 'Enter')
    type(q(form, 'textarea'), 'Move this')
    let finish = () => {}
    const write = fake.write
    vi.spyOn(fake, 'write').mockImplementationOnce(
      (path, patch) =>
        new Promise((resolve) => {
          finish = () => resolve(write(path, patch))
        }),
    )
    q<HTMLButtonElement>(form, 'button[type="submit"]').click()
    await settle()
    element.setAttribute('for', 'S-1')
    finish()
    await settle()
    element.removeAttribute('for')
    await settle()
    expect(byKey(form, 'remove-pin:main')!.parentElement!.hidden).toBe(true)
    type(q(form, 'textarea'), 'Something else')
    peer.calls = []
    q<HTMLButtonElement>(form, 'button[type="submit"]').click()
    await settle()
    expect(peer.sends()[0]!.patch).toMatchObject({ pin: null })
  })

  test('names a thread’s item once for is removed', async () => {
    const a = comment(LEE, 'First', { anchor: 'S-1', label: 'Step one' })
    peer.threads = [thread(a)]
    const { one } = await mountItems()
    expect(one.querySelector('.dossier-comments-place')).toBeNull()
    one.removeAttribute('for')
    await settle()
    expect(byKey(one, `anchor:${a.path}`)?.textContent).toBe('On Step one')
  })

  test('settles a send against the item it was written for, after for changes', async () => {
    const { one } = await mountItems()
    byKey(one, 'open')!.click()
    await settle()
    const area = q<HTMLTextAreaElement>(mainComposer(one), 'textarea')
    type(area, 'Same words')
    let finish = () => {}
    const write = fake.write
    vi.spyOn(fake, 'write').mockImplementationOnce(
      (path, patch) =>
        new Promise((resolve) => {
          finish = () => resolve(write(path, patch))
        }),
    )
    q<HTMLButtonElement>(mainComposer(one), 'button[type="submit"]').click()
    await settle()
    one.setAttribute('for', 'S-2')
    type(area, 'Same words')
    finish()
    await settle()
    // The other item's text stays, and the sent item's draft is gone.
    expect(area.value).toBe('Same words')
    one.setAttribute('for', 'S-1')
    expect(area.value).toBe('')
    one.setAttribute('for', 'S-2')
    expect(area.value).toBe('Same words')
  })

  test('writes a comment on its item, even before the item is drawn', async () => {
    const { one } = await mountItems()
    byKey(one, 'open')!.click()
    await settle()
    type(q(mainComposer(one), 'textarea'), 'Check the dates')
    peer.calls = []
    q<HTMLButtonElement>(mainComposer(one), 'button[type="submit"]').click()
    await settle()
    expect(peer.calls[0]).toEqual({
      op: 'write',
      path: FOLDER,
      patch: {
        text: 'Check the dates',
        anchor: 'S-1',
        label: 'Step one',
        pin: null,
        replyTo: null,
        stance: null,
        mentions: [],
      },
    })
    document.body.innerHTML =
      '<dossier-comments for="later"></dossier-comments>'
    await settle()
    const later = document.querySelector('dossier-comments') as HTMLElement
    byKey(later, 'open')!.click()
    await settle()
    type(q(mainComposer(later), 'textarea'), 'Before it is drawn')
    peer.calls = []
    q<HTMLButtonElement>(mainComposer(later), 'button[type="submit"]').click()
    await settle()
    expect(peer.calls[0]?.patch).toMatchObject({
      anchor: 'later',
      label: null,
    })
  })

  test('shows a thread whose item is gone under “On an earlier version”', async () => {
    const gone = comment(LEE, 'Was here', { anchor: 'S-9', label: 'Old step' })
    peer.threads = [thread(gone)]
    document.body.innerHTML = '<dossier-comments for="S-9"></dossier-comments>'
    await settle()
    const element = document.querySelector('dossier-comments') as HTMLElement
    byKey(element, 'open')!.click()
    await settle()
    const earlier = q<HTMLDetailsElement>(element, '.dossier-comments-earlier')
    expect(earlier.hidden).toBe(false)
    expect(rootsIn(element)).toEqual([gone.path])
    expect(q(element, '.dossier-comments-place').textContent).toBe(
      'On Old step',
    )
  })

  test('tells the page its threads with dossier:comments, each element its own', async () => {
    const a = comment(LEE, 'First', { anchor: 'S-1', stance: 'reopen' })
    peer.threads = [thread(a)]
    const seen: { for: string | null; roots: string[] }[] = []
    document.addEventListener('dossier:comments', (event) => {
      const detail = (event as CustomEvent<{ threads: Doc<Thread>[] }>).detail
      seen.push({
        for: (event.target as Element).getAttribute('for'),
        roots: detail.threads.map((t) => t.data.root.path),
      })
    })
    await mountItems()
    expect(seen).toEqual([
      { for: null, roots: [a.path] },
      { for: 'S-1', roots: [a.path] },
      { for: 'S-2', roots: [] },
    ])
    seen.length = 0
    const b = comment(LEE, 'Second', { anchor: 'S-2' })
    peer.emit([thread(a), thread(b)])
    await settle()
    // Only the elements whose threads changed.
    expect(seen).toEqual([
      { for: null, roots: [a.path, b.path] },
      { for: 'S-2', roots: [b.path] },
    ])
  })

  test('keeps unsent text per item, and gives a visitor’s kept comment back only to its own element', async () => {
    const { one, two } = await mountItems()
    for (const element of [one, two]) byKey(element, 'open')!.click()
    await settle()
    type(q(mainComposer(one), 'textarea'), 'On one')
    type(q(mainComposer(two), 'textarea'), 'On two')
    document.body.replaceChildren()
    const again = await mountItems()
    expect(
      q<HTMLTextAreaElement>(mainComposer(again.one), 'textarea').value,
    ).toBe('On one')
    expect(
      q<HTMLTextAreaElement>(mainComposer(again.two), 'textarea').value,
    ).toBe('On two')
    // Opened by the text left in it.
    expect(byKey(again.one, 'open')!.getAttribute('aria-expanded')).toBe('true')
    expect(
      q<HTMLTextAreaElement>(mainComposer(again.page), 'textarea').value,
    ).toBe('')
    document.body.replaceChildren()
    sessionStorage.clear()
    sessionStorage.setItem(
      keptKey(PAGE),
      JSON.stringify({ ...keptFor('Kept on two'), anchor: 'S-2', for: 'S-2' }),
    )
    const back = await mountItems()
    expect(
      q<HTMLTextAreaElement>(mainComposer(back.two), 'textarea').value,
    ).toBe('Kept on two')
    expect(
      q<HTMLTextAreaElement>(mainComposer(back.page), 'textarea').value,
    ).toBe('')
    // Nothing kept for it: still folded, its composer not built.
    expect(mainComposer(back.one)).toBeNull()
    expect(sessionStorage.getItem(keptKey(PAGE))).toBeNull()
  })
})
