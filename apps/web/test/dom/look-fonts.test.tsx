import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Fonts, type FontActions } from '../../src/components/look-fonts.tsx'
import { fuzzyScore } from '../../src/lib/font-search.ts'
import {
  AGENT964_LOOK,
  type FontChoice,
  type Look,
} from '../../src/lib/look.ts'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The project's types include the Workers runtime's, whose Element differs
// from the DOM's, so elements here are read through the few fields used.
let host: HTMLDivElement
let root: Root
let copied: string[]
let saved: Look[]

const FACE = {
  sha256: 'a'.repeat(64),
  format: 'woff2',
  weight: '400',
  style: 'normal',
  unicodeRange: null,
} as const

/** Copies as the deployment answers, recording what it was asked for. */
const actions = (refuse = false): FontActions => ({
  copyGoogleFont: async (family) => {
    copied.push(family)
    return refuse
      ? 'Google Fonts did not answer. Try again.'
      : { kind: 'google', family, faces: [FACE] }
  },
  uploadFont: async () => 'not in this test',
})

function Harness({ refuse = false }: { refuse?: boolean }) {
  const [draft, setDraft] = useState<Look>(AGENT964_LOOK)
  return (
    <Fonts
      draft={draft}
      onChange={(next) => {
        saved.push(next)
        setDraft(next)
      }}
      actions={actions(refuse)}
    />
  )
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host as never)
  root = createRoot(host as never)
  copied = []
  saved = []
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** Waits, rendering, until `done` holds: the catalogue's import or a copy. */
const until = async (done: () => boolean) => {
  for (let waited = 0; !done(); waited += 10) {
    if (waited > 10_000) throw new Error('waited 10 s')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
}

const button = (name: string) => {
  const found = host.querySelector(`button[aria-label="${name}"]`)
  if (found === null) throw new Error(`no button ${name}`)
  return found as unknown as HTMLButtonElement
}

const combobox = () =>
  host.querySelector(
    'input[role="combobox"][aria-label="Google Fonts family for Body"]',
  ) as unknown as HTMLInputElement

const listbox = () =>
  host.querySelector(
    `#${CSS.escape(combobox().getAttribute('aria-controls')!)}`,
  ) as unknown as HTMLElement

const options = () =>
  [...listbox().querySelectorAll('[role="option"]')] as unknown as HTMLElement[]

const optionNames = () =>
  options().map((option) => option.getAttribute('data-family'))

const activeName = () => {
  const id = combobox().getAttribute('aria-activedescendant')
  return id === null
    ? null
    : host.querySelector(`#${CSS.escape(id)}`)!.getAttribute('data-family')
}

const typeValue = (value: string) =>
  act(() => {
    const field = combobox()
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(field),
      'value',
    )!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }) as never)
  })

const key = (name: string) =>
  act(() => {
    combobox().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: name,
        bubbles: true,
        cancelable: true,
      }) as never,
    )
  })

const openBody = async (refuse = false) => {
  act(() => root.render(<Harness refuse={refuse} />))
  act(() => button('Change the Body font').click())
  await until(() => options().length > 0)
}

const bodyChoice = (): FontChoice => saved.at(-1)!.fonts.body

describe('choosing a Google font for a role', () => {
  it('lists Google Fonts families in a combobox, most used first, each in its own typeface', async () => {
    await openBody()
    const field = combobox()
    expect(document.activeElement).toBe(field)
    expect(field.getAttribute('aria-expanded')).toBe('true')
    expect(field.getAttribute('aria-autocomplete')).toBe('list')
    expect(listbox().getAttribute('role')).toBe('listbox')
    expect(optionNames().slice(0, 3)).toEqual([
      'Roboto',
      'Montserrat',
      'Open Sans',
    ])
    const first = options()[0]!
    expect(first.textContent).toContain('Roboto')
    expect(
      first.querySelector('[data-preview]')?.getAttribute('style'),
    ).toMatch(/^font-family: "?Roboto"?, sans-serif/)
    // The open row's button is named as it reads.
    const close = button('Close the Body font list')
    expect(close.textContent).toBe('Close')
    expect(close.getAttribute('aria-expanded')).toBe('true')
  })

  it('narrows the families by fuzzy search as the person types', async () => {
    await openBody()
    typeValue('jetbrns')
    const names = optionNames()
    expect(names[0]).toBe('JetBrains Mono')
    expect(names.every((name) => fuzzyScore('jetbrns', name!) !== null)).toBe(
      true,
    )
    // The status says how many match, for screen readers too.
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(
      /^\d+ famil(y|ies) match/,
    )
    typeValue('zzzzzz')
    expect(options()).toHaveLength(0)
    expect(combobox().getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(
      /No Google Fonts family matches/,
    )
  })

  it('moves through the families with the arrow keys and copies the one chosen with Enter', async () => {
    await openBody()
    typeValue('lit')
    expect(activeName()).toBe(optionNames()[0])
    key('ArrowDown')
    const second = optionNames()[1]!
    expect(activeName()).toBe(second)
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true')
    key('ArrowUp')
    key('ArrowDown')
    key('Enter')
    await until(() => saved.length > 0)
    expect(copied).toEqual([second])
    expect(bodyChoice()).toEqual({
      kind: 'google',
      family: second,
      faces: [FACE],
    })
    // The row names the new family and the panel closes.
    expect(host.textContent).toContain(`${second} · Google Fonts, copied here`)
    expect(button('Change the Body font').getAttribute('aria-expanded')).toBe(
      'false',
    )
  })

  it('copies a family clicked in the list', async () => {
    await openBody()
    typeValue('merriweather')
    const option = options().find(
      (o) => o.getAttribute('data-family') === 'Merriweather',
    )!
    act(() => option.click())
    await until(() => saved.length > 0)
    expect(copied).toEqual(['Merriweather'])
    expect(bodyChoice()).toMatchObject({
      kind: 'google',
      family: 'Merriweather',
    })
  })

  it('shows why a copy was refused and keeps the list open', async () => {
    await openBody(true)
    typeValue('inter')
    key('Enter')
    await until(() => host.querySelector('[role="alert"]') !== null)
    expect(copied).toEqual(['Inter'])
    expect(saved).toEqual([])
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'Google Fonts did not answer. Try again.',
    )
    expect(combobox()).not.toBeNull()
  })

  it('clears the search with Escape, then closes the list', async () => {
    await openBody()
    typeValue('inter')
    key('Escape')
    expect(combobox().value).toBe('')
    key('Escape')
    expect(button('Change the Body font').getAttribute('aria-expanded')).toBe(
      'false',
    )
    expect(document.activeElement).toBe(button('Change the Body font'))
  })

  it('keeps uploading a font file and agent964’s font', async () => {
    await openBody()
    expect(button('Upload a font file for Body')).not.toBeNull()
    expect(button("Use agent964's font for Body").disabled).toBe(true)
  })
})
