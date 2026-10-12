import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  deleted: null as unknown,
  purged: null as unknown,
  sent: [] as unknown[],
}))

vi.mock('../../src/server/listing', () => ({
  deleteNode: async ({ data }: { data: unknown }) => {
    server.sent.push(data)
    return server.deleted
  },
}))

vi.mock('../../src/server/admin', () => ({
  purgeNow: async () => {
    server.sent.push('purge')
    return server.purged
  },
}))

const { DeleteDialog } = await import('../../src/components/delete-dialog.tsx')
const { LastPurge, PurgeNow } =
  await import('../../src/components/purge-now.tsx')

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host as never)
  root = createRoot(host as never)
  server.sent = []
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = (node: { textContent: string | null } = document.body) =>
  (node.textContent ?? '').replace(/\s+/g, ' ')

const button = (name: string, within: ParentNode = document) => {
  const found = [...within.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === name,
  )
  if (found === undefined) throw new Error(`no button ${name}`)
  return found as unknown as { click: () => void }
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

describe("the listing's Delete", () => {
  it('asks first, naming the retention period, then deletes', async () => {
    let deleted = 0
    await act(async () => {
      root.render(
        <DeleteDialog
          deleting={{ name: 'plan.html', target: 'agent964/acme/plan.html' }}
          retentionDays={30}
          onClose={() => {}}
          onDeleted={() => {
            deleted += 1
          }}
        />,
      )
    })
    const sheet = dialog()
    expect(text(sheet)).toContain(
      'Delete plan.html?It stays restorable from history for 30 days.',
    )
    expect(server.sent).toEqual([])
    server.deleted = {
      path: 'plan.html',
      link: 'https://d.test/agent964/acme/plan',
      seq: 41,
      changed: ['plan.html'],
    }
    await click('Delete', sheet)
    expect(server.sent).toEqual([{ target: 'agent964/acme/plan.html' }])
    expect(deleted).toBe(1)
  })

  it('keeps a refusal in the dialog', async () => {
    await act(async () => {
      root.render(
        <DeleteDialog
          deleting={{ name: 'questions/', target: 'agent964/acme/questions/' }}
          retentionDays={1}
          onClose={() => {}}
          onDeleted={() => {}}
        />,
      )
    })
    const sheet = dialog()
    expect(text(sheet)).toContain(
      'Delete questions/?It stays restorable from history for 1 day.',
    )
    server.deleted = {
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Only write holders delete.',
        fix: null,
        path: null,
      },
    }
    await click('Delete', sheet)
    expect(sheet.querySelector('[role="alert"]')?.textContent).toBe(
      'Only write holders delete.',
    )
  })
})

const OUTCOME = {
  runId: 'run-1',
  trigger: 'manual' as const,
  expiredPushes: 0,
  nodes: 31,
  versions: 120,
  trees: 0,
  workspaces: 0,
  blobs: 40,
  records: 12,
  remaining: false,
}

describe('Purge now', () => {
  const render = async () => {
    let done = 0
    await act(async () => {
      root.render(
        <PurgeNow
          days={30}
          onDone={() => {
            done += 1
          }}
        />,
      )
    })
    return () => done
  }

  it('asks first, then says what went', async () => {
    const done = await render()
    await click('Purge now')
    const sheet = dialog()
    expect(text(sheet)).toContain('Purge everything past 30 days now?')
    expect(server.sent).toEqual([])
    server.purged = OUTCOME
    await click('Purge', sheet)
    expect(server.sent).toEqual(['purge'])
    expect(done()).toBe(1)
    expect(text()).toContain('Purged 120 versions and 31 files.')
    expect(text()).not.toContain('More remains.')
  })

  it('says when more remains for the next run', async () => {
    await render()
    await click('Purge now')
    server.purged = { ...OUTCOME, versions: 1, nodes: 1, remaining: true }
    await click('Purge', dialog())
    expect(text()).toContain('Purged 1 version and 1 file.')
    expect(text()).toContain(
      'More remains. The weekly run or another Purge now finishes it.',
    )
  })

  it('keeps a refusal in the dialog', async () => {
    await render()
    await click('Purge now')
    server.purged = {
      ok: false,
      error: {
        code: 'conflict',
        message: 'A purge is already running.',
        fix: null,
        path: null,
      },
    }
    const sheet = dialog()
    await click('Purge', sheet)
    expect(sheet.querySelector('[role="alert"]')?.textContent).toBe(
      'A purge is already running.',
    )
  })

  it('shows the last run under Health', async () => {
    await act(async () => {
      root.render(
        <LastPurge
          run={{
            trigger: 'weekly',
            state: 'partial',
            startedAt: Date.parse('2026-10-11T03:00:00Z'),
            finishedAt: Date.parse('2026-10-11T03:04:00Z'),
            outcome: { ...OUTCOME, trigger: 'weekly', remaining: true },
          }}
        />,
      )
    })
    expect(text()).toContain(
      'Last purge11 Oct, 03:04 UTC · weekly · 120 versions and 31 files · more remains',
    )
    await act(async () => {
      root.render(<LastPurge run={null} />)
    })
    expect(text()).toContain('No purge has run yet.')
  })
})
