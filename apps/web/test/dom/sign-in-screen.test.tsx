// The sign-in screen's buttons: one per provider the Deployment turned on,
// Google first, the line shown when none is, and what the screen says when a
// button cannot start the sign-in.
import type { ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SignInView } from '../../src/server/sign-in'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// What the screen's loader returned and the query it was opened with.
let loaded: SignInView
let search: { next?: string; error?: string; notice?: string; who?: string }

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useLoaderData: () => loaded,
    useSearch: () => search,
  }),
  redirect: (to: { href: string }) => ({ redirectTo: to.href }),
  Link: ({
    to,
    children,
    ...rest
  }: {
    to: string
    children: ReactNode
  } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}))
vi.mock('../../src/server/sign-in', () => ({
  signInView: () => new Promise(() => {}),
}))

const { Route } =
  (await import('../../src/routes/[_]/sign-in.tsx')) as unknown as {
    Route: { options: { component: () => ReactNode } }
  }
const SignInScreen = Route.options.component

const DEPLOYMENT = 'dossier.example.com'
const NEXT = '/agent964/acme/plan'

/** The view for a Deployment that turned on `providers`. */
const view = (
  providers: readonly ('google' | 'microsoft')[],
  over: Partial<SignInView> = {},
): SignInView =>
  ({
    deployment: DEPLOYMENT,
    providers,
    signedInAs: null,
    notice: null,
    origin: `https://${DEPLOYMENT}`,
    ...over,
  }) as unknown as SignInView

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host as never)
  root = createRoot(host as never)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const render = (next: SignInView, query: typeof search = {}) => {
  loaded = next
  search = { next: NEXT, ...query }
  act(() => root.render(<SignInScreen />))
}

const squash = (text: string | null | undefined) =>
  (text ?? '').replace(/\s+/g, ' ').trim()

const buttons = () => [...host.querySelectorAll('button')]
const labels = () => buttons().map((b) => squash(b.textContent))

const button = (label: string) => {
  const found = buttons().find((b) => squash(b.textContent) === label)
  if (found === undefined) throw new Error(`no button "${label}"`)
  return found
}

const alerts = () =>
  [...host.querySelectorAll('[role="alert"]')].map((a) => ({
    element: a,
    text: squash(a.textContent),
  }))

const NOT_SET_UP = 'Sign-in is not set up on this deployment yet.'
const DID_NOT_START = 'Sign-in did not start. Try again.'

/** Every POST the screen sends, with its body; each answered with `status`. */
const answering = (status: number) => {
  const sent: { url: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? 'null')) as unknown,
      })
      return new Response('{"message":"no"}', {
        status,
        headers: { 'content-type': 'application/json' },
      })
    },
  )
  return sent
}

const click = async (target: HTMLButtonElement) => {
  await act(async () => {
    target.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('the sign-in buttons', () => {
  it.each([
    { provider: 'google', label: 'Continue with Google' },
    { provider: 'microsoft', label: 'Continue with Microsoft' },
  ] as const)(
    'shows one button when only $provider is turned on',
    ({ provider, label }) => {
      render(view([provider]))
      expect(labels()).toEqual([label])
      expect(button(label).querySelector('svg')).not.toBeNull()
      expect(host.textContent).not.toContain(NOT_SET_UP)
    },
  )

  it('stacks Google then Microsoft, each with its mark and the same secondary weight', () => {
    render(view(['google', 'microsoft']))
    expect(labels()).toEqual([
      'Continue with Google',
      'Continue with Microsoft',
    ])
    const [google, microsoft] = buttons()
    expect(google?.querySelector('svg')).not.toBeNull()
    expect(microsoft?.querySelector('svg')).not.toBeNull()
    // Same weight: neither is the one solid primary button.
    for (const each of [google, microsoft]) {
      expect(each?.className).toContain('bg-secondary')
      expect(each?.className).not.toContain('bg-primary')
      expect(each?.className).toContain('w-full')
    }
    expect(google?.className).toBe(microsoft?.className)
    // Stacked: one above the other in the same column.
    expect(google?.parentElement).toBe(microsoft?.parentElement)
    expect(
      (google?.compareDocumentPosition(microsoft as Node) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(host.textContent).not.toContain(NOT_SET_UP)
  })

  it('says sign-in is not set up when no provider is turned on', () => {
    render(view([]))
    expect(buttons()).toEqual([])
    expect(squash(host.textContent)).toContain(NOT_SET_UP)
  })

  it.each([
    { provider: 'microsoft', label: 'Continue with Microsoft' },
    { provider: 'google', label: 'Continue with Google' },
  ] as const)(
    'posts $provider when its button is pressed, and says the sign-in did not start under the buttons when the start fails',
    async ({ provider, label }) => {
      const sent = answering(500)
      render(view(['google', 'microsoft']))
      expect(alerts()).toEqual([])
      await click(button(label))

      expect(sent).toHaveLength(1)
      expect(sent[0]?.url).toBe('/_/auth/sign-in/social')
      expect(sent[0]?.body).toMatchObject({ provider, callbackURL: NEXT })

      const shown = alerts().filter((a) => a.text === DID_NOT_START)
      expect(shown).toHaveLength(1)
      const last = buttons().at(-1)
      expect(
        (last?.compareDocumentPosition(shown[0]?.element as Node) ?? 0) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
      // The person can try again with either provider.
      expect(labels()).toEqual([
        'Continue with Google',
        'Continue with Microsoft',
      ])
      for (const each of buttons()) expect(each.disabled).toBe(false)
    },
  )
})

describe('the notices about a Microsoft account', () => {
  it('says Microsoft did not confirm a new account, points at the IT admin, and offers the buttons', () => {
    render(
      view(['google', 'microsoft'], {
        notice: {
          kind: 'not_confirmed',
          provider: 'microsoft',
          email: 'ana@contoso.test',
        },
      }),
      { error: 'not_confirmed', who: 'signed' },
    )
    expect(alerts().map((a) => a.text)).toEqual([
      `Microsoft didn't confirm that this account owns ana@contoso.test, so you can't use it to sign in to ${DEPLOYMENT}. Sign in another way, or ask your organisation's IT admin to verify the address's domain with Microsoft.`,
    ])
    expect(labels()).toEqual([
      'Continue with Google',
      'Continue with Microsoft',
    ])
  })

  it('says Microsoft did not share an email address', () => {
    render(
      view(['microsoft'], {
        notice: { kind: 'no_email', provider: 'microsoft' },
      }),
      { error: 'no_email', who: 'signed' },
    )
    expect(alerts().map((a) => a.text)).toEqual([
      `Microsoft didn't share an email address for this account, so you can't use it to sign in to ${DEPLOYMENT}. Sign in another way.`,
    ])
    expect(labels()).toEqual(['Continue with Microsoft'])
  })
})
