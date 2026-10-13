import axe from 'axe-core'
import type { ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The header's links are the router's; here they are plain links.
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
  // The header's bell refreshes the screen after marking all read.
  useRouter: () => ({ invalidate: async () => {} }),
}))
// The bell asks for its count: nobody has any here.
vi.stubGlobal('fetch', async () =>
  Response.json({ notifications: [], unread: 0, next: null }),
)
vi.mock('../../src/routes/__root', () => ({
  Route: { useLoaderData: () => undefined },
}))

const { AppHeader } = await import('../../src/components/app-header.tsx')
const { RowMenu, MenuButton } =
  await import('../../src/components/row-menu.tsx')

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

/** axe's name rules over what was rendered: their violations' ids. */
const nameViolations = async (): Promise<string[]> => {
  const results = await axe.run(host as never, {
    runOnly: {
      type: 'rule',
      values: ['label-content-name-mismatch', 'link-name', 'button-name'],
    },
    resultTypes: ['violations'],
  })
  return results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`,
  )
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Text under `element`, leaving out what `skip` says to. */
const textUnder = (element: Element, skip: (e: Element) => boolean): string =>
  [...element.childNodes]
    .map((node) =>
      node.nodeType === 3
        ? (node.textContent ?? '')
        : node.nodeType === 1 && !skip(node as Element)
          ? ` ${textUnder(node as Element, skip)} `
          : '',
    )
    .join('')

/** What a sighted person reads on it: everything but screen-reader text. */
const shownText = (element: Element): string =>
  squash(textUnder(element, (e) => e.classList.contains('sr-only')))

/** Its accessible name: its aria-label, else its text without hidden parts. */
const nameOf = (element: Element | null): string =>
  element === null
    ? ''
    : (element.getAttribute('aria-label') ??
      squash(
        textUnder(element, (e) => e.getAttribute('aria-hidden') === 'true'),
      ))

/**
 * Speech users say what they see: a name set apart from the content must
 * hold the content's text, as axe's label-content-name-mismatch asks (its
 * own check needs layout, which happy-dom has not).
 */
const expectNameHoldsShownText = (element: Element | null) => {
  expect(element).not.toBeNull()
  if (!element?.hasAttribute('aria-label')) return
  expect(nameOf(element).toLowerCase()).toContain(
    shownText(element).toLowerCase(),
  )
}

describe('accessible names hold the text people see', () => {
  it('names the account link by what it shows, on wide screens and phones', async () => {
    for (const beside of [undefined, <span key="beside">acme</span>]) {
      act(() =>
        root.render(<AppHeader email="sara@acme.com" beside={beside} />),
      )
      expect(await nameViolations()).toEqual([])
      const account = host.querySelector('a[href="/_/settings"]')
      expectNameHoldsShownText(account)
      expect(nameOf(account)).toContain('sara@acme.com')
      expect(nameOf(account)).toContain('Account settings')
    }
  })

  it('names a menu that shows its choice by that text first', async () => {
    act(() =>
      root.render(
        <ul>
          <li>
            <RowMenu trigger="Move to" about="member@acme.com">
              <MenuButton onSelect={() => {}}>Design</MenuButton>
            </RowMenu>
          </li>
        </ul>,
      ),
    )
    expect(await nameViolations()).toEqual([])
    const summary = host.querySelector('summary')
    expectNameHoldsShownText(summary)
    expect(nameOf(summary).startsWith('Move to')).toBe(true)
    expect(nameOf(summary)).toContain('member@acme.com')
  })
})
