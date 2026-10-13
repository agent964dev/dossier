import axe from 'axe-core'
import type { ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface Signed {
  readonly email: string
  readonly name: string
  readonly image: string | null
}

// What the root of every screen loaded: here, the signed-in person alone.
let signedIn: Signed | null = null

vi.mock('@tanstack/react-router', () => ({
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
vi.mock('../../src/routes/__root', () => ({
  Route: { useLoaderData: () => ({ name: 'Dossier', logo: null, signedIn }) },
}))

const { AppHeader } = await import('../../src/components/app-header.tsx')

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
  signedIn = null
})

const PHOTO = 'https://lh3.googleusercontent.com/a/sara=s96-c'

const chip = () => host.querySelector('a[href="/_/settings"]')

/** What a sighted person reads on it: everything but screen-reader text. */
const shownText = (element: Element | null) =>
  [...(element?.querySelectorAll(':scope > span:not([aria-hidden])') ?? [])]
    .filter((span) => !span.classList.contains('sr-only'))
    .map((span) => span.textContent)
    .join('')

/** Its accessible name: its text without the parts hidden from it. */
const nameOf = (element: Element | null) =>
  [...(element?.children ?? [])]
    .filter((child) => child.getAttribute('aria-hidden') !== 'true')
    .map((child) => child.textContent)
    .join('')

const violations = async () =>
  (
    await axe.run(host as never, {
      runOnly: {
        type: 'rule',
        values: ['link-name', 'image-alt', 'label-content-name-mismatch'],
      },
      resultTypes: ['violations'],
    })
  ).violations.map((v) => v.id)

describe('the account chip', () => {
  it('shows the person’s Google photo and name', async () => {
    signedIn = { email: 'sara@acme.com', name: 'Sara Haddad', image: PHOTO }
    act(() => root.render(<AppHeader email="sara@acme.com" />))
    const photo = chip()?.querySelector('img')
    expect(photo?.getAttribute('src')).toBe(PHOTO)
    expect(photo?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(photo?.getAttribute('alt')).toBe('')
    expect(shownText(chip())).toBe('Sara Haddad')
    expect(chip()?.textContent).not.toContain('sara@acme.com')
    expect(nameOf(chip())).toBe('Account settings, Sara Haddad')
    expect(await violations()).toEqual([])
  })

  it('shows the name’s initial when there is no photo', () => {
    signedIn = { email: 'sara@acme.com', name: 'Sara Haddad', image: null }
    act(() => root.render(<AppHeader email="sara@acme.com" />))
    expect(chip()?.querySelector('img')).toBeNull()
    expect(chip()?.querySelector('[aria-hidden]')?.textContent).toBe('S')
    expect(nameOf(chip())).toBe('Account settings, Sara Haddad')
  })

  it('falls back to the initial when the photo does not load', () => {
    signedIn = { email: 'sara@acme.com', name: 'Sara Haddad', image: PHOTO }
    act(() => root.render(<AppHeader email="sara@acme.com" />))
    const photo = chip()?.querySelector('img')
    act(() => {
      photo?.dispatchEvent(new Event('error'))
    })
    expect(chip()?.querySelector('img')).toBeNull()
    expect(chip()?.querySelector('[aria-hidden]')?.textContent).toBe('S')
  })

  it('shows the email and its initial when there is no name', async () => {
    signedIn = { email: 'sara@acme.com', name: '', image: null }
    act(() => root.render(<AppHeader email="sara@acme.com" />))
    expect(shownText(chip())).toBe('sara@acme.com')
    expect(chip()?.querySelector('[aria-hidden]')?.textContent).toBe('s')
    expect(nameOf(chip())).toBe('Account settings, sara@acme.com')
    expect(await violations()).toEqual([])
  })

  it('shows the email the screen names when the loaded person is someone else', () => {
    signedIn = { email: 'old@acme.com', name: 'Old Person', image: PHOTO }
    act(() => root.render(<AppHeader email="sara@acme.com" />))
    expect(chip()?.querySelector('img')).toBeNull()
    expect(nameOf(chip())).toBe('Account settings, sara@acme.com')
  })

  it('keeps the photo alone beside another control on phones', () => {
    signedIn = { email: 'sara@acme.com', name: 'Sara Haddad', image: PHOTO }
    act(() =>
      root.render(
        <AppHeader email="sara@acme.com" beside={<span>acme</span>} />,
      ),
    )
    const label = [...(chip()?.children ?? [])].at(-1)
    expect(label?.textContent).toBe('Sara Haddad')
    expect(label?.className).toContain('max-sm:sr-only')
    expect(chip()?.querySelector('img')).not.toBeNull()
  })
})
