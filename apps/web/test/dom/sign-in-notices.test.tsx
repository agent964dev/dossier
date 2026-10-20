// The words the sign-in screen shows for each notice, with Google in the
// provider's place.
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

/** The view for a Deployment with Google turned on. */
const view = (over: Record<string, unknown>): SignInView =>
  ({
    deployment: DEPLOYMENT,
    ready: true,
    providers: ['google'],
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
})

const render = (next: SignInView, query: typeof search = {}) => {
  loaded = next
  search = { next: '/agent964/acme/plan', ...query }
  act(() => root.render(<SignInScreen />))
}

const squash = (text: string | null | undefined) =>
  (text ?? '').replace(/\s+/g, ' ').trim()

const alertText = () => {
  const alerts = [...host.querySelectorAll('[role="alert"]')]
  expect(alerts).toHaveLength(1)
  return squash(alerts[0]?.textContent)
}

const continueLink = () =>
  [...host.querySelectorAll('a')].find(
    (a) => squash(a.textContent) === 'Continue',
  )

const googleButton = () =>
  [...host.querySelectorAll('button')].find(
    (b) => squash(b.textContent) === 'Continue with Google',
  )

describe('the sign-in screen', () => {
  it('says Google did not confirm a new account, and offers to sign in another way', () => {
    render(
      view({
        notice: {
          kind: 'not_confirmed',
          provider: 'google',
          email: 'sara@acme.test',
        },
      }),
      { error: 'not_confirmed', who: 'signed' },
    )
    expect(alertText()).toBe(
      `Google didn't confirm that this account owns sara@acme.test, so you can't use it to sign in to ${DEPLOYMENT}. Sign in another way.`,
    )
    expect(continueLink()).toBeUndefined()
    expect(googleButton()).toBeDefined()
  })

  it('says Google did not share an email address', () => {
    render(view({ notice: { kind: 'no_email', provider: 'google' } }), {
      error: 'no_email',
      who: 'signed',
    })
    expect(alertText()).toBe(
      `Google didn't share an email address for this account, so you can't use it to sign in to ${DEPLOYMENT}. Sign in another way.`,
    )
    expect(continueLink()).toBeUndefined()
    expect(googleButton()).toBeDefined()
  })

  it('names Google when another account already uses the email', () => {
    render(
      view({
        notice: {
          kind: 'email_unconfirmed',
          provider: 'google',
          email: 'sara@acme.test',
        },
      }),
      { error: 'email_unconfirmed', who: 'signed' },
    )
    expect(alertText()).toBe(
      `Another account already uses sara@acme.test on ${DEPLOYMENT}, and Google can't confirm this one still owns the address. Sign in with the other account, or ask an admin of your workspace for help.`,
    )
    expect(continueLink()).toBeUndefined()
  })

  it('keeps the email Google did not confirm, and continues where the person was going', () => {
    render(
      view({
        signedInAs: 'lina@gmail.com',
        notice: {
          kind: 'kept_unconfirmed',
          provider: 'google',
          email: 'lina.new@gmail.com',
        },
      }),
      { notice: 'kept_unconfirmed', who: 'signed' },
    )
    expect(alertText()).toBe(
      `Google didn't confirm that this account owns lina.new@gmail.com, so you stay lina@gmail.com on ${DEPLOYMENT}.`,
    )
    expect(continueLink()?.getAttribute('href')).toBe('/agent964/acme/plan')
    expect(googleButton()).toBeUndefined()
  })

  it('names Google when its new address belongs to another person, and continues', () => {
    render(
      view({
        signedInAs: 'lina@gmail.com',
        notice: {
          kind: 'email_in_use',
          provider: 'google',
          email: 'other@gmail.com',
        },
      }),
      { notice: 'email_in_use', who: 'signed' },
    )
    expect(alertText()).toBe(
      `Google now gives this account the address other@gmail.com, which another person already uses on ${DEPLOYMENT}. You stay signed in as lina@gmail.com. Ask an admin of your workspace to sort out the two addresses.`,
    )
    expect(continueLink()?.getAttribute('href')).toBe('/agent964/acme/plan')
  })

  it('says only that sign-in did not finish when there is no notice to read', () => {
    render(view({}), { error: 'unavailable' })
    expect(alertText()).toBe('Sign-in did not finish. Try again.')
    expect(googleButton()).toBeDefined()
  })
})
