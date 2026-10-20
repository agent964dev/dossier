import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SignInAccountView } from '../../src/core/index'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const server = vi.hoisted(() => ({
  answer: (): unknown => undefined,
  sent: [] as unknown[],
}))

vi.mock('../../src/server/account', () => ({
  disconnectSignInAccount: async ({ data }: { data: unknown }) => {
    server.sent.push(data)
    return server.answer()
  },
}))

const { SignInAccounts } =
  await import('../../src/components/sign-in-accounts.tsx')

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host as never)
  root = createRoot(host as never)
  server.sent = []
  server.answer = () => undefined
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const text = (node: { textContent: string | null } = host) =>
  (node.textContent ?? '').replace(/\s+/g, ' ')

const buttons = (within: ParentNode = document) =>
  [...within.querySelectorAll('button')] as unknown as (Element & {
    click: () => void
  })[]

const button = (name: string, within: ParentNode = document) => {
  const found = buttons(within).find(
    (b) =>
      b.getAttribute('aria-label') === name ||
      (b.textContent ?? '').trim() === name,
  )
  if (found === undefined) throw new Error(`no button ${name}`)
  return found
}

const dialog = () => {
  const open = [...document.querySelectorAll('dialog')].find((d) =>
    d.hasAttribute('open'),
  )
  if (open === undefined) throw new Error('no open dialog')
  return open as unknown as Element & ParentNode
}

const rows = () => [...host.querySelectorAll('li')]

const google: SignInAccountView = {
  id: 'acct_google',
  provider: 'google',
  email: 'ana@contoso.com',
  current: true,
  agentKeys: 1,
}

const microsoft: SignInAccountView = {
  id: 'acct_microsoft',
  provider: 'microsoft',
  email: 'ana@contoso.onmicrosoft.com',
  current: false,
  agentKeys: 2,
}

const render = async (
  accounts: readonly SignInAccountView[],
  onChange: () => Promise<void> = async () => {},
) => {
  await act(async () => {
    root.render(
      <SignInAccounts
        accounts={accounts}
        personEmail="ana@contoso.com"
        onChange={onChange}
      />,
    )
  })
}

describe("the account page's sign-in accounts", () => {
  it('lists each account with its provider, and this session without Disconnect', async () => {
    await render([google, microsoft])
    expect(text(host.querySelector('h2') as never)).toBe('Sign-in accounts 2')
    const [first, second] = rows()
    expect(text(first as never)).toBe(
      'ana@contoso.comGooglethis sessionTo disconnect this account, sign in with another one.',
    )
    expect(buttons(first as never)).toEqual([])
    expect(text(second as never)).toBe(
      'ana@contoso.onmicrosoft.comMicrosoftDisconnect',
    )
    expect(
      button('Disconnect Microsoft account ana@contoso.onmicrosoft.com'),
    ).toBeDefined()
    expect(text()).not.toContain('This is your only sign-in account.')
  })

  it('offers no Disconnect on the only account', async () => {
    await render([google])
    expect(buttons(rows()[0] as never)).toEqual([])
    expect(text()).toContain(
      'This is your only sign-in account. To remove it, delete your account below.',
    )
    expect(text()).not.toContain('To disconnect this account')
  })

  it('asks first in the exact words, then disconnects and reloads the list', async () => {
    let reloaded = 0
    await render([google, microsoft], async () => {
      reloaded += 1
    })
    await act(async () => {
      button('Disconnect Microsoft account ana@contoso.onmicrosoft.com').click()
    })
    expect(text(dialog())).toContain(
      'Disconnect your Microsoft account ana@contoso.onmicrosoft.com?' +
        'Its sessions end, its 2 agent keys stop working, and the CLI logins it approved are cancelled. ' +
        'You stay signed in with your other accounts. ' +
        'If you sign in with it again later, it joins you again only when Microsoft can confirm it still owns ana@contoso.com.',
    )
    expect(server.sent).toEqual([])
    await act(async () => {
      button('Disconnect', dialog()).click()
    })
    expect(server.sent).toEqual([{ accountId: 'acct_microsoft' }])
    expect(reloaded).toBe(1)
    expect(document.querySelector('dialog[open]')).toBeNull()
  })

  it('keeps the list and says so when the disconnect fails', async () => {
    let reloaded = 0
    await render([microsoft, { ...google, current: false }], async () => {
      reloaded += 1
    })
    server.answer = () => ({
      ok: false,
      error: {
        code: 'unavailable',
        message: 'Something went wrong. Try again.',
        fix: null,
        path: null,
      },
    })
    await act(async () => {
      button('Disconnect Google account ana@contoso.com').click()
    })
    await act(async () => {
      button('Disconnect', dialog()).click()
    })
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't disconnect this account. Try again.",
    )
    server.answer = () => {
      throw new Error('offline')
    }
    await act(async () => {
      button('Disconnect', dialog()).click()
    })
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't disconnect this account. Try again.",
    )
    expect(reloaded).toBe(0)
    expect(rows()).toHaveLength(2)
  })

  it('says why the server refused', async () => {
    await render([google, microsoft])
    server.answer = () => ({
      ok: false,
      error: {
        code: 'last_account',
        message: 'This is your only sign-in account.',
        fix: 'To remove it, delete your account in account settings.',
        path: null,
      },
    })
    await act(async () => {
      button('Disconnect Microsoft account ana@contoso.onmicrosoft.com').click()
    })
    await act(async () => {
      button('Disconnect', dialog()).click()
    })
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
      'This is your only sign-in account. To remove it, delete your account in account settings.',
    )
  })

  it('says one agent key in the singular', async () => {
    await render([microsoft, { ...google, current: false }])
    await act(async () => {
      button('Disconnect Google account ana@contoso.com').click()
    })
    expect(text(dialog())).toContain(
      'Its sessions end, its 1 agent key stops working, and the CLI logins',
    )
  })
})
