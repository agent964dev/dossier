// @vitest-environment happy-dom
import type {
  DossierNotification,
  Me,
  NotificationsList,
} from '@dossier/contracts/bridge'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import {
  COPIED_FOR,
  COPY_LABEL,
  DossierCopy,
} from '../src/base/components/dossier-copy.ts'
import {
  DIFF_MAX_BYTES,
  DossierDiff,
  UNIFIED_BELOW_PX,
} from '../src/base/components/dossier-diff.ts'
import { define as defineNotifications } from '../src/base/components/dossier-notifications.ts'
import type { Dossier } from '../src/page-client/create-page-client.ts'

const PAGE = 'https://t1.content.test/_/v/HANDLE/3/rich/copy'

beforeAll(() => {
  ;(
    window as unknown as { happyDOM: { setURL: (url: string) => void } }
  ).happyDOM.setURL(PAGE)
  if (customElements.get('dossier-copy') === undefined) {
    customElements.define('dossier-copy', DossierCopy)
  }
  if (customElements.get('dossier-diff') === undefined) {
    customElements.define('dossier-diff', DossierDiff)
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  document.documentElement.removeAttribute('dir')
  for (const style of document.head.querySelectorAll('style')) style.remove()
})

/** Requests the page made, and the answers by path. */
const serve = (answers: Record<string, () => Response>) => {
  const requests: Request[] = []
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input as string, init)
    requests.push(request)
    const answer = answers[new URL(request.url).pathname]
    return answer === undefined
      ? new Response('Not found.', { status: 404 })
      : answer()
  })
  return requests
}

const markdown = (text: string) => () =>
  new Response(text, { headers: { 'content-type': 'text/markdown' } })

/** A clipboard that takes writes, or refuses them. */
const clipboard = (refuses = false) => {
  const written: string[] = []
  class Item {
    constructor(readonly items: Record<string, Promise<Blob>>) {}
  }
  vi.stubGlobal('ClipboardItem', Item)
  Object.defineProperty(window, 'ClipboardItem', {
    value: Item,
    configurable: true,
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      write: async (items: Item[]) => {
        const blob = await items[0]!.items['text/plain']!
        if (refuses) throw new DOMException('Denied', 'NotAllowedError')
        written.push(await blob.text())
      },
      writeText: async (text: string) => {
        if (refuses) throw new DOMException('Denied', 'NotAllowedError')
        written.push(text)
      },
    },
  })
  return written
}

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0))
}

const place = (html: string) => {
  document.body.innerHTML = html
  return document.body.firstElementChild as HTMLElement
}

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
    let quote: string | null = null
    for (let at = 0; at < text.length; at += 1) {
      const char = text[at]
      if (quote !== null) {
        if (char === '\\') at += 1
        else if (char === quote) quote = null
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '{') {
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

/** Base styles sit in the dossier layer, which the head declares first. */
const expectBaseLayerFirst = () => {
  const order = document.head.firstElementChild
  expect(order?.getAttribute('data-dossier-base-order')).toBe('')
  expect(order?.textContent).toBe('@layer dossier;')
  for (const sheet of document.querySelectorAll('style[data-dossier-base]')) {
    expect(sheet.textContent!.startsWith('@layer dossier{')).toBe(true)
  }
}

/** Physical sides a layout that follows dir must not use. */
const PHYSICAL =
  /(?:^|[;{\s])(?:margin|padding|border)-(?:left|right)\s*:|(?:^|[;{\s])(?:left|right)\s*:|float\s*:|text-align\s*:\s*(?:left|right)/

describe('<dossier-copy>', () => {
  test('copies the page’s agent version from its own frame URL, asking for Markdown', async () => {
    const requests = serve({ '/_/v/HANDLE/3/rich/copy': markdown('# Copy\n') })
    const written = clipboard()
    const copy = place('<dossier-copy></dossier-copy>')
    const button = copy.querySelector('button')!
    expect(button.textContent).toBe(COPY_LABEL)
    expect(button.type).toBe('button')
    button.click()
    await settle()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe(PAGE)
    expect(requests[0]!.headers.get('accept')).toBe('text/markdown')
    expect(written).toEqual(['# Copy\n'])
    expect(copy.querySelector('.dossier-copy-status')!.textContent).toBe(
      'Copied',
    )
    expect(copy.querySelector('[role="status"]')).not.toBeNull()
  })

  test('clears "Copied" after three seconds', async () => {
    serve({ '/_/v/HANDLE/3/rich/copy': markdown('# Copy\n') })
    clipboard()
    const copy = place('<dossier-copy></dossier-copy>')
    copy.querySelector('button')!.click()
    await settle()
    expect(copy.querySelector('.dossier-copy-status')!.textContent).toBe(
      'Copied',
    )
    await new Promise((r) => setTimeout(r, COPIED_FOR + 50))
    expect(copy.querySelector('.dossier-copy-status')!.textContent).toBe('')
  }, 10_000)

  test('copies src relative to the page, with its label', async () => {
    const requests = serve({ '/_/v/HANDLE/3/brief/': markdown('# Brief\n') })
    const written = clipboard()
    const copy = place(
      '<dossier-copy src="../brief/" label="Copy brief for agent"></dossier-copy>',
    )
    const button = copy.querySelector('button')!
    expect(button.textContent).toBe('Copy brief for agent')
    copy.setAttribute('label', 'Copy the brief')
    expect(button.textContent).toBe('Copy the brief')
    button.click()
    await settle()
    expect(requests[0]!.url).toBe('https://t1.content.test/_/v/HANDLE/3/brief/')
    expect(requests[0]!.headers.get('accept')).toBe('text/markdown')
    expect(written).toEqual(['# Brief\n'])
  })

  test('shows the text selected when the clipboard refuses', async () => {
    serve({ '/_/v/HANDLE/3/rich/copy': markdown('# Copy\n') })
    clipboard(true)
    const copy = place('<dossier-copy></dossier-copy>')
    copy.querySelector('button')!.click()
    await settle()
    const area = copy.querySelector('textarea.dossier-copy-text')!
    expect(area).not.toBeNull()
    expect((area as HTMLTextAreaElement).value).toBe('# Copy\n')
    expect((area as HTMLTextAreaElement).readOnly).toBe(true)
    expect(document.activeElement).toBe(area)
    expect((area as HTMLTextAreaElement).selectionStart).toBe(0)
    expect((area as HTMLTextAreaElement).selectionEnd).toBe('# Copy\n'.length)
    expect(copy.querySelector('.dossier-copy-status')!.textContent).toBe(
      'Copy the selected text.',
    )
  })

  test('says so when the text cannot be loaded', async () => {
    serve({})
    const written = clipboard()
    const copy = place('<dossier-copy src="missing"></dossier-copy>')
    copy.querySelector('button')!.click()
    await settle()
    expect(written).toEqual([])
    expect(copy.querySelector('textarea')).toBeNull()
    expect(copy.querySelector('.dossier-copy-status')!.textContent).toBe(
      'Could not load the text to copy.',
    )
  })

  test('uses writeText after the fetch where ClipboardItem is missing', async () => {
    serve({ '/_/v/HANDLE/3/rich/copy': markdown('# Copy\n') })
    const written = clipboard()
    Object.defineProperty(window, 'ClipboardItem', {
      value: undefined,
      configurable: true,
    })
    const copy = place('<dossier-copy></dossier-copy>')
    copy.querySelector('button')!.click()
    await settle()
    expect(written).toEqual(['# Copy\n'])
  })

  test('renders into the page’s DOM with zero-specificity styles that follow dir', () => {
    document.documentElement.setAttribute('dir', 'rtl')
    const author = document.createElement('style')
    author.textContent = '@layer tree { .dossier-copy-button { color: red } }'
    document.head.append(author)
    const copy = place('<dossier-copy></dossier-copy>')
    expect(copy.shadowRoot).toBeNull()
    expect(copy.hasAttribute('dir')).toBe(false)
    expect(copy.querySelector('[dir]')).toBeNull()
    const sheets = [...document.querySelectorAll('style[data-dossier-base]')]
    expect(sheets.map((s) => s.getAttribute('data-dossier-base'))).toEqual([
      'dossier-copy',
    ])
    const css = sheets.map((s) => s.textContent ?? '').join('\n')
    const list = selectors(css)
    expect(list.length).toBeGreaterThan(0)
    for (const selector of list)
      expect(selector.startsWith(':where(')).toBe(true)
    expect(css).not.toMatch(PHYSICAL)
    // The author's layer comes after the base layer, so it wins.
    expectBaseLayerFirst()
    // A second copy button adds no second stylesheet.
    document.body.append(document.createElement('dossier-copy'))
    expect(document.querySelectorAll('style[data-dossier-base]')).toHaveLength(
      1,
    )
  })
})

describe('<dossier-diff>', () => {
  const PLAN_V1 = '# Plan\n\nWe ship in March.\n'
  const PLAN = '# Plan\n\nWe ship in April.\n\nAfter review.\n'

  /** A stand-in ResizeObserver the test drives, and the element's width. */
  const sizing = () => {
    const observers: (() => void)[] = []
    class Observer {
      constructor(readonly callback: () => void) {
        observers.push(callback)
      }
      observe() {}
      disconnect() {}
    }
    Object.defineProperty(window, 'ResizeObserver', {
      value: Observer,
      configurable: true,
    })
    let width = 900
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ width }) as DOMRect,
    )
    return {
      resize: (to: number) => {
        width = to
        for (const callback of observers) callback()
      },
    }
  }

  const diffPage = (attrs: string) => {
    serve({
      '/_/v/HANDLE/3/rich/v1/plan.md': markdown(PLAN_V1),
      '/_/v/HANDLE/3/rich/plan.md': markdown(PLAN),
      '/_/v/HANDLE/3/rich/big.md': () =>
        new Response('x'.repeat(DIFF_MAX_BYTES + 1)),
    })
    return place(`<dossier-diff ${attrs}></dossier-diff>`)
  }

  const status = (diff: HTMLElement) =>
    diff.querySelector('.dossier-diff-status')!.textContent

  const loaded = async (diff: HTMLElement) => {
    await vi.waitFor(
      () => expect(diff.querySelector('.dossier-diff-code pre')).not.toBeNull(),
      { timeout: 10_000 },
    )
  }

  test('renders split from 640 px of its own width and unified below it', async () => {
    const size = sizing()
    const diff = diffPage('before="v1/plan.md" after="plan.md" lang="text"')
    await loaded(diff)
    const pre = () => diff.querySelector('.dossier-diff-code pre')!
    expect(pre().getAttribute('data-diff-type')).toBe('split')
    size.resize(UNIFIED_BELOW_PX - 1)
    await vi.waitFor(() =>
      expect(pre().getAttribute('data-diff-type')).toBe('single'),
    )
    size.resize(UNIFIED_BELOW_PX)
    await vi.waitFor(() =>
      expect(pre().getAttribute('data-diff-type')).toBe('split'),
    )
    expect(status(diff)).toBe('')
    expect(diff.querySelector('.dossier-diff-files')!.textContent).toBe(
      'v1/plan.md → plan.md',
    )
    expect(diff.querySelector('.dossier-diff-counts')!.textContent).toBe(
      '−1 +3',
    )
  }, 20_000)

  test('keeps a fixed layout whatever its width', async () => {
    const size = sizing()
    const diff = diffPage(
      'before="v1/plan.md" after="plan.md" lang="text" layout="unified"',
    )
    await loaded(diff)
    size.resize(1200)
    await settle()
    expect(
      diff
        .querySelector('.dossier-diff-code pre')!
        .getAttribute('data-diff-type'),
    ).toBe('single')
  }, 20_000)

  test('shows "Could not load v1/plan.md." when a side answers 404', async () => {
    sizing()
    serve({ '/_/v/HANDLE/3/rich/plan.md': markdown(PLAN) })
    const diff = place(
      '<dossier-diff before="v1/plan.md" after="plan.md"></dossier-diff>',
    )
    expect(status(diff)).toBe('Loading diff…')
    expect(diff.querySelector('.dossier-diff')!.getAttribute('aria-busy')).toBe(
      'true',
    )
    await vi.waitFor(() =>
      expect(status(diff)).toBe('Could not load v1/plan.md.'),
    )
    expect(diff.querySelector('.dossier-diff')!.hasAttribute('aria-busy')).toBe(
      false,
    )
    expect(diff.querySelector('.dossier-diff-code')!.childElementCount).toBe(0)
  })

  test('in a page downloaded as one file, names each side by the name its data: URL keeps', async () => {
    sizing()
    const dataUrl = (name: string, text: string) =>
      `data:text/markdown;name=${encodeURIComponent(name)};base64,${btoa(text)}`
    const diff = place(
      `<dossier-diff before="${dataUrl('v1/plan.md', PLAN_V1)}" after="${dataUrl('plan.md', PLAN)}" lang="text"></dossier-diff>`,
    )
    await loaded(diff)
    expect(diff.querySelector('.dossier-diff-files')!.textContent).toBe(
      'v1/plan.md → plan.md',
    )
    expect(
      diff.querySelector('.dossier-diff-code')!.getAttribute('aria-label'),
    ).toBe('Changes in v1/plan.md → plan.md')
  }, 20_000)

  test('shows the size message for a side past 1 MiB', async () => {
    sizing()
    const diff = diffPage('before="v1/plan.md" after="big.md"')
    await vi.waitFor(() =>
      expect(status(diff)).toBe('This diff is too large to show here.'),
    )
  })

  test('renders a unified diff file from src', async () => {
    sizing()
    const patch = [
      'diff --git a/app.txt b/app.txt',
      '--- a/app.txt',
      '+++ b/app.txt',
      '@@ -1,2 +1,2 @@',
      ' one',
      '-two',
      '+2',
      '',
    ].join('\n')
    serve({ '/_/v/HANDLE/3/rich/changes.patch': () => new Response(patch) })
    const diff = place(
      '<dossier-diff src="changes.patch" lang="text"></dossier-diff>',
    )
    await loaded(diff)
    expect(diff.querySelector('.dossier-diff-counts')!.textContent).toBe(
      '−1 +1',
    )
    expect(diff.textContent).toContain('two')
  }, 20_000)

  test('renders into the page’s DOM, keeps its code left to right and its styles scoped', async () => {
    sizing()
    document.documentElement.setAttribute('dir', 'rtl')
    const diff = diffPage('before="v1/plan.md" after="plan.md" lang="text"')
    await loaded(diff)
    expect(diff.shadowRoot).toBeNull()
    const root = diff.querySelector('.dossier-diff')!
    expect(root.hasAttribute('dir')).toBe(false)
    expect(
      diff.querySelector('.dossier-diff-toolbar')!.hasAttribute('dir'),
    ).toBe(false)
    expect(
      diff.querySelector('.dossier-diff-counts')!.getAttribute('dir'),
    ).toBe('ltr')
    const code = diff.querySelector('.dossier-diff-code')!
    expect(code.getAttribute('dir')).toBe('ltr')
    expect(code.getAttribute('tabindex')).toBe('0')
    expect(code.getAttribute('aria-label')).toBe(
      'Changes in v1/plan.md → plan.md',
    )
    const sheets = [...document.querySelectorAll('style[data-dossier-base]')]
    expect(
      sheets.map((s) => s.getAttribute('data-dossier-base')).sort(),
    ).toEqual(['dossier-diff', 'dossier-diff-code'])
    for (const sheet of sheets) {
      for (const selector of selectors(sheet.textContent ?? '')) {
        expect(selector.startsWith(':where(')).toBe(true)
      }
    }
    const own = sheets.find(
      (s) => s.getAttribute('data-dossier-base') === 'dossier-diff',
    )!
    expect(own.textContent).not.toMatch(PHYSICAL)
    // The library's sheet lives in its own layer, scoped to the code region.
    const library = sheets.find(
      (s) => s.getAttribute('data-dossier-base') === 'dossier-diff-code',
    )!
    expect(library.textContent!.startsWith('@layer dossier{@layer diff{')).toBe(
      true,
    )
    expectBaseLayerFirst()
    expect(library.textContent).not.toContain(':host')
  }, 20_000)

  test('lets each line take the direction of its own text, so Arabic reads right to left in the left-to-right grid', async () => {
    sizing()
    const diff = diffPage('before="v1/plan.md" after="plan.md" lang="text"')
    await loaded(diff)
    const own = document.querySelector(
      'style[data-dossier-base="dossier-diff"]',
    )!
    const rule = /([^{}]+)\{[^}]*unicode-bidi:\s*plaintext/.exec(
      own.textContent ?? '',
    )
    expect(rule).not.toBeNull()
    const lines = diff.querySelectorAll('[data-line]')
    expect(lines.length).toBeGreaterThan(0)
    // happy-dom cannot match :where() with a combinator; read it instead.
    const scoped = /^:where\((.*)\)$/.exec(rule![1]!.trim())![1]!
    for (const line of lines) expect(line.matches(scoped)).toBe(true)
  }, 20_000)
})

describe('<dossier-notifications>', () => {
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
    link: `https://main.test/acme/plans/a/plan#dossier-comment=plan.comments%2Fsara%40acme.com%2F${n}.json&on=S-1`,
    at: new Date(Date.now() - n * 60 * 60_000).toISOString(),
    read: false,
    agent: false,
    ...over,
  })

  /** The page client the bell reads through. */
  const viewer = {
    me: { email: 'lee@acme.com', name: 'Lee', role: 'read' } as Me | null,
    pages: [] as NotificationsList[],
    unread: 0,
    /** What marking read answers: how many stay unread. */
    left: 0,
    list: vi.fn(),
    read: vi.fn(),
  }
  const dossier = {
    get me() {
      return viewer.me
    },
    ready: Promise.resolve(),
    notifications: {
      list: (opts: { before?: string | null }) => {
        viewer.list(opts)
        return Promise.resolve(
          viewer.pages[opts.before == null ? 0 : 1] ?? viewer.pages[0]!,
        )
      },
      unread: () => Promise.resolve(viewer.unread),
      read: (ids: readonly string[] | 'all') => {
        viewer.read(ids)
        return Promise.resolve(viewer.left)
      },
    },
  } as unknown as Dossier

  beforeAll(() => {
    defineNotifications(customElements, dossier)
  })
  afterEach(() => {
    viewer.me = { email: 'lee@acme.com', name: 'Lee', role: 'read' }
    viewer.pages = []
    viewer.unread = 0
    viewer.left = 0
    viewer.list.mockReset()
    viewer.read.mockReset()
  })

  const bell = async () => {
    const element = place(
      '<header><dossier-notifications></dossier-notifications></header>',
    ).firstElementChild as HTMLElement
    await settle()
    return {
      element,
      button: element.querySelector('button')!,
      badge: element.querySelector<HTMLElement>(
        '.dossier-notifications-badge',
      )!,
      panel: element.querySelector<HTMLElement>('[role="dialog"]')!,
    }
  }

  const buttonNamed = (root: ParentNode, name: string) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent === name)!

  test('shows its unread count, 9+ past nine, in a name screen readers hear, and nothing to a visitor', async () => {
    viewer.unread = 3
    const { element, button, badge } = await bell()
    expect(element.hidden).toBe(false)
    expect(badge.textContent).toBe('3')
    expect(badge.getAttribute('aria-hidden')).toBe('true')
    expect(button.textContent).toContain('Notifications, 3 unread')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    viewer.unread = 10
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(badge.textContent).toBe('9+')
    expect(button.textContent).toContain('Notifications, more than 9 unread')
    viewer.me = null
    const visitor = await bell()
    expect(visitor.element.hidden).toBe(true)
  })

  test('lists the newest first with who, what, where, an excerpt and when, unread marked, then older ones and all read', async () => {
    viewer.unread = 2
    viewer.pages = [
      {
        notifications: [
          note(1),
          note(2, {
            type: 'reply',
            actor: { email: 'kai@acme.com', name: null, image: null },
            anchor: null,
            label: null,
            read: true,
          }),
        ],
        unread: 2,
        next: 'cursor-1',
      },
      {
        notifications: [note(30, { team: 'Design', agent: true })],
        unread: 2,
        next: null,
      },
    ]
    const { button, panel } = await bell()
    button.click()
    await settle()
    expect(panel.hidden).toBe(false)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement?.textContent).toBe('Notifications')
    const items = () => [
      ...panel.querySelectorAll<HTMLAnchorElement>(
        '.dossier-notifications-item',
      ),
    ]
    expect(items().map((a) => a.textContent)).toEqual([
      'SUnread: Sara Haddad mentioned youPlan · PricingCan you check the price?1 h ago',
      'kkai@acme.com replied to your threadPlanCan you check the price?2 h ago',
    ])
    expect(items()[0]!.hasAttribute('data-unread')).toBe(true)
    expect(items()[1]!.hasAttribute('data-unread')).toBe(false)
    expect(items()[0]!.getAttribute('href')).toBe(note(1).link)

    const more = buttonNamed(panel, 'Show more')
    more.click()
    await settle()
    expect(viewer.list).toHaveBeenLastCalledWith({ before: 'cursor-1' })
    expect(items()).toHaveLength(3)
    expect(items()[2]!.textContent).toContain(
      'Sara Haddad Agent mentioned Design',
    )
    expect(
      items()[2]!.querySelector('.dossier-notifications-agent')?.textContent,
    ).toBe('Agent')
    expect(more.hidden).toBe(true)

    buttonNamed(panel, 'Mark all as read').click()
    await settle()
    expect(viewer.read).toHaveBeenCalledWith('all')
    expect(items().some((a) => a.hasAttribute('data-unread'))).toBe(false)
    expect(button.textContent).not.toContain('unread')
  })

  test('reads one when it is chosen, says all caught up when there are none, and closes on Escape with focus back on the bell', async () => {
    viewer.unread = 1
    viewer.pages = [{ notifications: [note(1)], unread: 1, next: null }]
    const { button, panel, badge } = await bell()
    button.click()
    await settle()
    const item = panel.querySelector<HTMLAnchorElement>('a')!
    item.addEventListener('click', (event) => event.preventDefault())
    item.click()
    expect(viewer.read).toHaveBeenCalledWith(['n1'])
    // The count Dossier answers.
    await settle()
    expect(badge.hidden).toBe(true)

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    expect(panel.hidden).toBe(true)
    expect(document.activeElement).toBe(button)

    viewer.pages = [{ notifications: [], unread: 0, next: null }]
    button.click()
    await settle()
    const empty = panel.querySelector<HTMLElement>(
      '.dossier-notifications-empty',
    )!
    expect(empty.hidden).toBe(false)
    expect(empty.textContent).toBe("You're all caught up")
    // Pressing elsewhere closes it too.
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(panel.hidden).toBe(true)
  })

  test('takes the count Dossier answers when one is chosen, and shows that row read', async () => {
    viewer.unread = 10
    viewer.left = 10
    viewer.pages = [
      { notifications: [note(1), note(2)], unread: 10, next: null },
    ]
    const { button, panel, badge } = await bell()
    button.click()
    await settle()
    const row = panel.querySelector<HTMLAnchorElement>('a')!
    row.addEventListener('click', (event) => event.preventDefault())
    row.click()
    await settle()
    // Ten or more stay unread: still "9+", never one less than the cap.
    expect(badge.textContent).toBe('9+')
    expect(row.hasAttribute('data-unread')).toBe(false)
    expect(row.textContent).not.toContain('Unread:')
    row.click()
    await settle()
    expect(viewer.read.mock.calls).toEqual([[['n1']]])
  })

  test('keeps focus on the same notification when the list refreshes', async () => {
    viewer.unread = 2
    viewer.pages = [
      { notifications: [note(1), note(2)], unread: 2, next: null },
    ]
    const { button, panel } = await bell()
    button.click()
    await settle()
    const second = () =>
      panel.querySelectorAll<HTMLAnchorElement>(
        '.dossier-notifications-item',
      )[1]!
    second().focus()
    expect(document.activeElement).toBe(second())
    // A new one arrives; the list is asked again on focus.
    viewer.pages = [
      { notifications: [note(0), note(1), note(2)], unread: 3, next: null },
    ]
    window.dispatchEvent(new Event('focus'))
    await settle()
    const focused = document.activeElement as HTMLAnchorElement
    expect(focused.classList.contains('dossier-notifications-item')).toBe(true)
    expect(focused.getAttribute('href')).toBe(note(2).link)
  })

  test('renders into the page’s DOM with zero-specificity styles that follow dir', async () => {
    const { element } = await bell()
    expect(element.shadowRoot).toBeNull()
    const css =
      document.querySelector('style[data-dossier-base="dossier-notifications"]')
        ?.textContent ?? ''
    const list = selectors(css)
    expect(list.length).toBeGreaterThan(0)
    for (const selector of list) {
      expect(selector.startsWith(':where(')).toBe(true)
    }
    expect(css).not.toMatch(PHYSICAL)
    expectBaseLayerFirst()
  })
})
