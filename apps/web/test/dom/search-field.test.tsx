import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { fieldParts, SearchField } from '../../src/components/search-field.tsx'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let seen: string[] = []

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host as never)
  root = createRoot(host as never)
  seen = []
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

let entered = 0

function Harness({ start }: { start: string }) {
  const [text, setText] = useState(start)
  return (
    <SearchField
      id="f"
      value={text}
      onChange={(next) => {
        seen.push(next)
        setText(next)
      }}
      onEnter={() => {
        entered += 1
      }}
    />
  )
}

const input = () => host.querySelector('input') as unknown as HTMLInputElement
const label = () =>
  [...host.querySelectorAll('span')].find((s) => s.textContent === 'in') ?? null
const hint = () => host.querySelector('#f-mode')?.textContent ?? null

/** Types the input's new value with the caret at `caret`, as a browser does. */
const typeValue = (value: string, caret = value.length) =>
  act(() => {
    const field = input()
    const set = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(field),
      'value',
    )!.set!
    set.call(field, value)
    field.setSelectionRange(caret, caret)
    field.dispatchEvent(new Event('input', { bubbles: true }) as never)
  })

const key = (name: string, composing = false) =>
  act(() => {
    input().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: name,
        bubbles: true,
        cancelable: true,
        isComposing: composing,
      }) as never,
    )
  })

describe('the search field', () => {
  it('reads "in " at the start as the contents label', () => {
    expect(fieldParts('in budget')).toEqual({ content: true, rest: 'budget' })
    expect(fieldParts('inbox')).toEqual({ content: false, rest: 'inbox' })
    expect(fieldParts('in')).toEqual({ content: false, rest: 'in' })
  })

  it('searches titles and paths until "in " is typed before the words, then shows the label and keeps the caret at the words', () => {
    act(() => root.render(<Harness start="" />))
    expect(input().placeholder).toBe('Search titles and paths')
    expect(label()).toBeNull()
    typeValue('erbil')
    typeValue('in erbil', 3)
    expect(seen.at(-1)).toBe('in erbil')
    expect(input().value).toBe('erbil')
    expect(input().selectionStart).toBe(0)
    expect(label()).not.toBeNull()
    expect(input().placeholder).toBe('Search page contents')
    expect(hint()).toBe('Page contents · backspace for titles')
  })

  it('takes the label away with Backspace at the start of the words, and only there', () => {
    act(() => root.render(<Harness start="in erbil" />))
    act(() => input().setSelectionRange(2, 2))
    key('Backspace')
    expect(label()).not.toBeNull()
    act(() => input().setSelectionRange(0, 0))
    key('Backspace')
    expect(seen.at(-1)).toBe('erbil')
    expect(label()).toBeNull()
    expect(input().value).toBe('erbil')
  })

  it('clears the field, label and words, with Esc', () => {
    act(() => root.render(<Harness start="in erbil" />))
    key('Escape')
    expect(seen.at(-1)).toBe('')
    expect(input().value).toBe('')
    expect(label()).toBeNull()
  })

  it('leaves Enter, Esc and Backspace to an input method while it composes', () => {
    entered = 0
    act(() => root.render(<Harness start="in erbil" />))
    act(() => input().setSelectionRange(0, 0))
    key('Enter', true)
    key('Escape', true)
    key('Backspace', true)
    expect(entered).toBe(0)
    expect(seen).toEqual([])
    expect(label()).not.toBeNull()
    key('Enter')
    expect(entered).toBe(1)
  })
})
