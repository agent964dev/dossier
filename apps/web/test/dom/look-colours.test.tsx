import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Advanced, Palette } from '../../src/components/look-colours.tsx'
import { AGENT964_LOOK, PRESETS, type Look } from '../../src/lib/look.ts'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The project's types include the Workers runtime's, whose Element differs
// from the DOM's, so elements here are read through the few fields used.
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

const render = (element: React.ReactNode) => act(() => root.render(element))

/** The input or select a label names. */
const labelled = (text: string): { readonly value: string } => {
  const label = [...host.querySelectorAll('label')].find(
    (l) => l.textContent?.trim() === text,
  )
  if (label === undefined) throw new Error(`no label ${text}`)
  return host.querySelector(`#${CSS.escape(label.htmlFor)}`) as unknown as {
    readonly value: string
  }
}

const withForeground = (look: Look, color: string): Look => ({
  ...look,
  roles: { ...look.roles, foreground: { color } },
})

describe('choosing a preset while a role has a colour of its own', () => {
  it('shows the preset’s colour in the role’s field', () => {
    const noop = () => {}
    render(
      <Advanced
        draft={withForeground(AGENT964_LOOK, '#111111')}
        onChange={noop}
      />,
    )
    expect(labelled('foreground').value).toBe('own')
    const field = () =>
      host.querySelector<HTMLInputElement>(
        'input[aria-label="foreground colour, OKLCH or HEX"]',
      )!
    expect(field().value).toBe('#111111')
    // A preset replaces the whole draft, roles included.
    render(
      <Advanced
        draft={withForeground(PRESETS.Studio, '#222222')}
        onChange={noop}
      />,
    )
    expect(field().value).toBe('#222222')
    // A preset that leaves the role at its default, then a colour again,
    // starts from the role's colour now rather than an old entry.
    render(<Advanced draft={PRESETS.Acme} onChange={noop} />)
    expect(labelled('foreground').value).toBe('')
    render(
      <Advanced
        draft={withForeground(PRESETS.Acme, '#333333')}
        onChange={noop}
      />,
    )
    expect(field().value).toBe('#333333')
  })
})

describe('choosing a preset while a step is open', () => {
  it('shows the preset’s colour in the step’s field', () => {
    const noop = () => {}
    render(<Palette draft={AGENT964_LOOK} onChange={noop} />)
    const swatch = host.querySelector<HTMLButtonElement>(
      'button[aria-label^="brand-300,"]',
    )!
    act(() => swatch.click())
    const field = labelled('brand-300')
    expect(field.value).toBe(AGENT964_LOOK.palette.brand[300])
    render(<Palette draft={PRESETS.Studio} onChange={noop} />)
    expect(labelled('brand-300').value).toBe(PRESETS.Studio.palette.brand[300])
  })
})
