import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ShareDialogView } from '../../src/server/share-dialog.ts'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  view: null as unknown,
  sent: [] as unknown[],
}))

vi.mock('../../src/server/share-dialog', () => ({
  shareDialogView: async () => server.view,
  setShare: async ({ data }: { data: unknown }) => {
    server.sent.push(data)
    return server.view
  },
}))

const { ShareDialog } = await import('../../src/components/share-dialog.tsx')

// Elements are read through the few DOM fields used, as the Workers types
// the project includes differ from the DOM's.
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

const VIEW: ShareDialogView = {
  title: 'Share plan.html',
  kind: 'page',
  workspace: 'acme',
  teams: [],
  direct: [],
  inherited: [
    {
      key: 'workspace',
      target: { kind: 'workspace' },
      label: 'Everyone in acme',
      role: 'write',
      from: 'acme/',
    },
    {
      key: 'anyone',
      target: { kind: 'anyone' },
      label: 'Anyone with the link',
      role: 'write',
      from: 'acme/',
    },
  ],
  workspaceRole: null,
  anyoneRole: null,
  publicReach: [],
}

const select = (label: string) => {
  const found = document.querySelector(`select[aria-label="${label}"]`)
  if (found === null) throw new Error(`no select ${label}`)
  return found as unknown as {
    value: string
    dispatchEvent: (e: Event) => boolean
  }
}

const choose = async (label: string, value: string) => {
  const field = select(label)
  await act(async () => {
    field.value = value
    field.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('the share dialog under shares from a folder above', () => {
  it('lists them apart and sets any role on the node itself', async () => {
    server.view = VIEW
    await act(async () => {
      root.render(<ShareDialog link="/acme/t/plan" onClose={() => {}} />)
    })
    const text = document.body.textContent ?? ''
    expect(text).toContain('Write · from acme/')
    // The node's own rows start at no access, whatever is inherited.
    expect(select('Role of everyone in acme').value).toBe('')
    expect(select('Role of anyone with the link').value).toBe('')
    // A lower role than the inherited one is still a share of its own.
    await choose('Role of everyone in acme', 'read')
    await choose('Role of anyone with the link', 'respond')
    expect(server.sent).toEqual([
      { link: '/acme/t/plan', target: { kind: 'workspace' }, role: 'read' },
      { link: '/acme/t/plan', target: { kind: 'anyone' }, role: 'respond' },
    ])
  })
})

describe('the Anyone with the link button', () => {
  it('says in its name that it makes the page public at once', async () => {
    server.view = { ...VIEW, inherited: [] }
    await act(async () => {
      root.render(<ShareDialog link="/acme/t/plan" onClose={() => {}} />)
    })
    const button = [...document.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').startsWith('Anyone with the link'),
    )
    expect(button).toBeDefined()
    // No label apart from its text: what it says is its name, and what it
    // shows comes first.
    expect(button!.hasAttribute('aria-label')).toBe(false)
    const name = (button!.textContent ?? '').replace(/\s+/g, ' ').trim()
    expect(name).toMatch(/^Anyone with the link\b/)
    expect(name).toMatch(/public/i)
    expect(name).toMatch(/read and respond/i)
  })
})
