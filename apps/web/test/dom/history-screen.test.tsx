// The viewer's clock: three hours ahead of UTC.
process.env.TZ = 'Asia/Baghdad'

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  HistoryLine,
  HistoryView,
  PushView,
} from '../../src/server/history.ts'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  older: null as unknown,
  restored: null as unknown,
  diff: null as unknown,
  asked: [] as unknown[],
  restores: [] as unknown[],
  diffs: [] as unknown[],
}))

vi.mock('../../src/server/history', () => ({
  historyView: async ({ data }: { data: unknown }) => {
    server.asked.push(data)
    return server.older
  },
  restore: async ({ data }: { data: unknown }) => {
    server.restores.push(data)
    return server.restored
  },
  diffView: async ({ data }: { data: unknown }) => {
    server.diffs.push(data)
    return server.diff
  },
}))

// The code itself is @pierre/diffs' to draw; here it only names its texts.
vi.mock('../../src/components/diff-code', () => ({
  DiffCode: (props: { before: string | null; after: string | null }) => (
    <pre data-testid="code">
      {props.before} → {props.after}
    </pre>
  ),
}))

const { HistoryScreen, PushDetail } =
  await import('../../src/components/history-screen.tsx')

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host as never)
  root = createRoot(host as never)
  server.asked = []
  server.restores = []
  server.diffs = []
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const TARGET = 'agent964/acme/'

const base = {
  seq: 0,
  at: '2026-10-11T09:30:00.000Z',
  by: 'lina',
  path: 'plan.html',
  push: null,
  to: null,
  restorable: false,
  who: 'lina',
  name: 'plan.html',
  restore: null,
} as const

const line = (fields: Partial<HistoryLine>): HistoryLine =>
  ({ ...base, ...fields }) as unknown as HistoryLine

const DELETED = line({
  kind: 'delete',
  seq: 40 as never,
  restorable: true,
  label: 'Deleted plan.html',
  at: '2026-10-11T09:30:00.000Z',
  meta: 'lina',
  restore: {
    target: 'agent964/acme/plan.html',
    to: { at: Date.parse('2026-10-11T09:30:00.000Z') - 1 },
  },
})
const PURGED = line({
  kind: 'delete',
  seq: 39 as never,
  path: 'old.html',
  name: 'old.html',
  restorable: false,
  label: 'Deleted old.html',
  at: '2026-09-01T09:30:00.000Z',
  meta: 'omar',
})
const PUSH_12 = line({
  kind: 'push',
  seq: 38 as never,
  by: 'owner',
  who: 'owner',
  path: '',
  push: { number: 12 as never, message: 'First questions', files: 3 },
  label: 'Push 12 · First questions',
  at: '2026-10-10T09:30:00.000Z',
  meta: 'owner · 3 files',
  restore: { target: TARGET, to: { push: 12 } },
})
const RESTORED = line({
  kind: 'restore',
  seq: 37 as never,
  by: 'owner',
  who: 'owner',
  to: 'push 9',
  label: 'Restored plan.html to push 9',
  at: '2026-10-10T09:30:00.000Z',
  meta: 'owner',
})
const MOVED = line({
  kind: 'move',
  seq: 36 as never,
  to: 'plans/plan.html',
  label: 'Moved plan.html to plans/plan.html',
  at: '2026-10-10T09:30:00.000Z',
  meta: 'lina',
})
const WITHDRAWN = line({
  kind: 'withdrawal',
  seq: 35 as never,
  by: 'sara@acme.com',
  who: 'sara@acme.com',
  path: 'answers/sara@acme.com.json',
  name: 'answers/sara@acme.com.json',
  label: 'sara@acme.com withdrew a submission',
  at: '2026-10-09T09:30:00.000Z',
  meta: '',
})

const PUSH_9 = line({
  kind: 'push',
  seq: 34 as never,
  by: 'omar',
  who: 'omar',
  path: '',
  push: { number: 9 as never, message: 'Brief', files: 1 },
  label: 'Push 9 · Brief',
  at: '2026-10-08T09:30:00.000Z',
  meta: 'omar · 1 file',
  restore: { target: TARGET, to: { push: 9 } },
})

const view = (fields: Partial<HistoryView> = {}): HistoryView => ({
  deployment: 'agent964',
  me: { email: 'owner@acme.com', name: 'Owner' },
  crumbs: [
    { name: 'agent964', href: '/?w=agent964' },
    { name: 'acme', href: 'https://d.test/agent964/acme/' },
    { name: 'history', href: '/_/history/agent964/acme/' },
  ],
  folder: { name: 'acme/', link: 'https://d.test/agent964/acme/' },
  target: TARGET,
  lines: [DELETED, PURGED, PUSH_12, RESTORED, MOVED, WITHDRAWN, PUSH_9],
  next: null,
  retentionDays: 30,
  ...fields,
})

const AT = { workspace: 'agent964', tree: 'acme', path: '', folder: true }

const opened: number[] = []
const show = async (
  v: HistoryView,
  push: { number: number; view: PushView } | null = null,
) => {
  await act(async () => {
    root.render(
      <HistoryScreen
        view={v}
        at={AT}
        opened={push}
        pushHref={(n) =>
          n === null ? '/_/history/agent964/acme/' : `?push=${n}`
        }
        onOpenPush={(n) => {
          if (n !== null) opened.push(n)
        }}
        onRestored={() => {}}
      />,
    )
  })
}

const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')

const rows = () =>
  [...document.querySelectorAll('main ul > li')].map((li) =>
    (li.textContent ?? '').replace(/\s+/g, ' ').trim(),
  )

const button = (name: string, within: ParentNode = document) => {
  const found = [...within.querySelectorAll('button')].find(
    (b) =>
      b.getAttribute('aria-label') === name ||
      (b.textContent ?? '').trim() === name,
  )
  if (found === undefined) throw new Error(`no button ${name}`)
  return found as unknown as { click: () => void; disabled: boolean }
}

const click = async (name: string, within?: ParentNode) => {
  await act(async () => {
    button(name, within).click()
  })
}

const dialog = () => {
  const open = [...document.querySelectorAll('dialog')].find((d) =>
    d.hasAttribute('open'),
  )
  if (open === undefined) throw new Error('no open dialog')
  return open as unknown as Element & ParentNode
}

describe('times in the history', () => {
  it('show each line’s day on the viewer’s clock', async () => {
    // 23:30 UTC on 12 Oct is 02:30 on 13 Oct in Baghdad.
    const late = line({
      kind: 'delete',
      seq: 41 as never,
      at: '2026-10-12T23:30:00.000Z',
      label: 'Deleted late.html',
      meta: 'lina',
    })
    await show(view({ lines: [late] }))
    expect(text()).toContain('13 Oct · lina')
    expect(text()).not.toContain('12 Oct')
  })
})

describe('the history list', () => {
  it('shows every kind of line, newest first, with its own actions', async () => {
    await show(view())
    expect(rows()).toEqual([
      'Deleted plan.html11 Oct · linaRestore',
      'Deleted old.html1 Sept · omar',
      '12Push 12 · First questions10 Oct · owner · 3 filesRestore to here',
      'Restored plan.html to push 910 Oct · owner',
      'Moved plan.html to plans/plan.html10 Oct · lina',
      'sara@acme.com withdrew a submission9 Oct',
      // An older push restores from its own page.
      '9Push 9 · Brief8 Oct · omar · 1 file',
    ])
    // Restore only on a deletion still within the retention period.
    expect(button('Restore plan.html')).toBeTruthy()
    expect(() => button('Restore old.html')).toThrow()
    // A withdrawal names who and when, nothing of what was sent.
    const withdrawal = [...document.querySelectorAll('main ul > li')].at(-2)!
    expect(withdrawal.querySelectorAll('button, a')).toHaveLength(0)
    expect(text()).toContain('acme/, newest first')
    expect(text()).toContain(
      'Deleted files and data stay restorable for 30 days, then are purged.',
    )
  })

  it('opens a push from its line', async () => {
    opened.length = 0
    await show(view())
    const link = document.querySelector('a[href="?push=12"]')!
    await act(async () => {
      ;(link as unknown as { click: () => void }).click()
    })
    expect(opened).toEqual([12])
  })

  it('says when there is no history yet', async () => {
    await show(view({ lines: [] }))
    expect(text()).toContain('No history yet.')
    expect(text()).not.toContain('Show older')
  })

  it('shows older lines after the first page', async () => {
    await show(view({ lines: [DELETED], next: 'cursor-2' }))
    server.older = view({ lines: [WITHDRAWN], next: null })
    await click('Show older')
    expect(server.asked).toEqual([{ ...AT, cursor: 'cursor-2' }])
    expect(rows()).toEqual([
      'Deleted plan.html11 Oct · linaRestore',
      'sara@acme.com withdrew a submission9 Oct',
    ])
    expect(text()).not.toContain('Show older')
  })
})

describe('the restore sheet', () => {
  it('names what comes back and restores it to the moment before its deletion', async () => {
    await show(
      view({
        lines: [
          {
            ...DELETED,
            push: { number: 12 as never, message: null, files: 1 },
          },
        ],
      }),
    )
    await click('Restore plan.html')
    const sheet = dialog()
    expect(sheet.textContent).toContain('Restore plan.html?')
    expect(sheet.textContent).toContain(
      'It comes back as it was before lina deleted it on 11 Oct, from push 12.',
    )
    server.restored = {
      path: 'plan.html',
      link: 'https://d.test/agent964/acme/plan',
      seq: 41,
      changed: ['plan.html'],
    }
    await click('Restore', sheet)
    expect(server.restores).toEqual([
      {
        target: 'agent964/acme/plan.html',
        to: { at: Date.parse('2026-10-11T09:30:00.000Z') - 1 },
      },
    ])
    expect(text()).toContain('Restored plan.html.')
  })

  it('says a newer file is in the way, and keeps the sheet open', async () => {
    await show(view())
    await click('Restore plan.html')
    server.restored = {
      ok: false,
      error: {
        code: 'conflict',
        message: 'plan.html exists.',
        fix: null,
        path: null,
      },
    }
    const sheet = dialog()
    await click('Restore', sheet)
    expect(sheet.querySelector('[role="alert"]')?.textContent).toBe(
      'A newer plan.html is there now. Move it first.',
    )
    expect(sheet.hasAttribute('open')).toBe(true)
  })

  it('says when a deletion is past the retention period', async () => {
    await show(view())
    await click('Restore plan.html')
    server.restored = {
      ok: false,
      error: {
        code: 'not_found',
        message: 'plan.html was purged after 30 days.',
        fix: null,
        path: null,
      },
    }
    const sheet = dialog()
    await click('Restore', sheet)
    expect(sheet.querySelector('[role="alert"]')?.textContent).toBe(
      'plan.html was purged after 30 days.',
    )
  })

  it('restores the folder to a push from its line', async () => {
    await show(view())
    await click('Restore to here, push 12')
    const sheet = dialog()
    expect(sheet.textContent).toContain('Restore acme/ to push 12?')
    server.restored = { path: '', link: '', seq: 42, changed: [] }
    await click('Restore', sheet)
    expect(server.restores).toEqual([{ target: TARGET, to: { push: 12 } }])
  })
})

const PUSH: PushView = {
  number: 12,
  title: 'First questions',
  label: 'Push 12 · First questions',
  at: '2026-10-10T09:30:00.000Z',
  meta: 'owner · 3 files',
  files: [
    {
      path: 'plan.html',
      name: 'plan.html',
      target: 'agent964/acme/plan.html',
      change: 'changed',
      text: true,
      added: 2,
      removed: 1,
      lines: 120,
    },
    {
      path: 'questions/index.html',
      name: 'questions/index.html',
      target: 'agent964/acme/questions/index.html',
      change: 'added',
      text: true,
      added: 48,
      removed: 0,
      lines: 48,
    },
    {
      path: 'old/notes.md',
      name: 'old/notes.md',
      target: 'agent964/acme/old/notes.md',
      change: 'deleted',
      text: true,
      added: 0,
      removed: 12,
      lines: 12,
    },
    {
      path: 'mockups/erbil-map.png',
      name: 'mockups/erbil-map.png',
      target: 'agent964/acme/mockups/erbil-map.png',
      change: 'changed',
      text: false,
      added: null,
      removed: null,
      lines: null,
    },
  ],
}

const fileRows = () =>
  [
    ...document.querySelectorAll('ul[aria-label="Files push 12 changed"] > li'),
  ].map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim())

describe('an opened push', () => {
  it('lists its files with their change and line counts, and a binary file as binary', async () => {
    server.diff = {
      path: 'plan.html',
      from: 'push 11',
      to: 'push 12',
      binary: false,
      before: '<p>Per pallet</p>',
      after: '<p>Per truck</p>',
      patch: null,
    }
    await act(async () => {
      root.render(
        <PushDetail
          push={PUSH}
          backHref="/_/history/agent964/acme/"
          onBack={() => {}}
          onRestore={() => {}}
        />,
      )
    })
    expect(text()).toContain('Push 12 · First questions')
    expect(text()).toContain('10 Oct · owner · 3 files')
    expect(fileRows()).toEqual([
      'plan.htmlchanged+2 −1',
      'questions/index.htmladded · 48 lines+48',
      'old/notes.mddeleted · 12 lines−12',
      'mockups/erbil-map.pngchangedBinary',
    ])
    // A binary file opens no diff.
    const binary = document.querySelectorAll(
      'ul[aria-label="Files push 12 changed"] > li',
    )[3]!
    expect(binary.querySelector('button')).toBeNull()
    // The first text file opens with the push, and its diff loads.
    const toggles = [
      ...document.querySelectorAll(
        'ul[aria-label="Files push 12 changed"] button',
      ),
    ].map((b) => b.getAttribute('aria-expanded'))
    expect(toggles).toEqual(['true', 'false', 'false'])
    expect(server.diffs).toEqual([
      { target: 'agent964/acme/plan.html', from: null, to: 12 },
    ])
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.querySelector('[data-testid="code"]')?.textContent).toBe(
      '<p>Per pallet</p> → <p>Per truck</p>',
    )
  })

  it('shows a file too large or binary for a diff as changed, with no code', async () => {
    server.diff = {
      path: 'plan.html',
      from: 'push 11',
      to: 'push 12',
      binary: true,
      before: null,
      after: null,
      patch: null,
    }
    await act(async () => {
      root.render(
        <PushDetail
          push={PUSH}
          backHref="/"
          onBack={() => {}}
          onRestore={() => {}}
        />,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(text()).toContain(
      'Changed · binary or too large to show line by line',
    )
    expect(document.querySelector('[data-testid="code"]')).toBeNull()
  })

  it('beside the list, marks its line as the open one', async () => {
    server.diff = {
      path: 'plan.html',
      from: null,
      to: null,
      binary: true,
      before: null,
      after: null,
      patch: null,
    }
    await show(view(), { number: 12, view: PUSH })
    expect(document.querySelector('a[aria-current="true"]')?.textContent).toBe(
      'Push 12 · First questions',
    )
  })
})
