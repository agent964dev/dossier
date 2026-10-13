import { CONTENT_PREFIX } from '@dossier/contracts/bridge'
import { FileText, Search } from 'lucide-react'
import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
} from 'react'

import { cn } from '../lib/utils'

/** Text that starts with "in " searches page contents. */
const PREFIX = new RegExp(`^\\s*${CONTENT_PREFIX}`)

/** The field's text as its mode and the words after the label. */
export const fieldParts = (
  text: string,
): { readonly content: boolean; readonly rest: string } => {
  const match = PREFIX.exec(text)
  return match === null
    ? { content: false, rest: text }
    : { content: true, rest: text.slice(match[0].length) }
}

export interface SearchFieldHandle {
  /** Focuses the field with the caret after its text. */
  readonly focusEnd: () => void
}

/**
 * The search field: titles and paths by default; typing "in " at the start
 * turns into an "in" label and searches page contents, and Backspace at the
 * start of the words removes the label. Esc clears the field. `value` is
 * the whole text, with "in " when the label shows.
 */
export const SearchField = forwardRef<
  SearchFieldHandle,
  {
    readonly value: string
    readonly onChange: (text: string) => void
    readonly onEnter?: () => void
    readonly className?: string
    readonly id?: string
  }
>(function SearchField({ value, onChange, onEnter, className, id }, ref) {
  const input = useRef<HTMLInputElement>(null)
  /** Where the caret goes after the next render, when the label moved it. */
  const caret = useRef<number | null>(null)
  const { content, rest } = fieldParts(value)
  const hintId = `${id ?? 'search'}-mode`

  useImperativeHandle(ref, () => ({
    focusEnd: () => {
      const field = input.current
      if (field === null) return
      field.focus()
      field.setSelectionRange(field.value.length, field.value.length)
    },
  }))

  // After a render that moved the label, the caret goes back to its words.
  useLayoutEffect(() => {
    const at = caret.current
    if (at === null || input.current === null) return
    caret.current = null
    input.current.setSelectionRange(at, at)
  })

  const typed = (text: string, at: number | null) => {
    if (content) {
      onChange(`${CONTENT_PREFIX}${text}`)
      return
    }
    const parts = fieldParts(text)
    if (parts.content) {
      // "in " became the label: the caret keeps its place in the words.
      caret.current = Math.max(
        0,
        (at ?? text.length) - (text.length - parts.rest.length),
      )
    }
    onChange(text)
  }

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const field = event.currentTarget
    // While an input method composes (Arabic, Japanese, …), its keys are
    // its own: Enter picks a candidate, Esc cancels it.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      if (value === '') return
      event.preventDefault()
      onChange('')
      return
    }
    if (
      event.key === 'Backspace' &&
      content &&
      field.selectionStart === 0 &&
      field.selectionEnd === 0
    ) {
      event.preventDefault()
      caret.current = 0
      onChange(rest)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      onEnter?.()
    }
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <label
        className={cn(
          'flex min-h-11 min-w-0 cursor-text items-center gap-2 rounded-lg border border-border bg-input px-3 md:min-h-[2.375rem]',
          'transition-[border-color,box-shadow] duration-200 ease-agent',
          'focus-within:border-brand-300/60 focus-within:ring-[3px] focus-within:ring-ring/30',
        )}
      >
        <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        {content ? (
          <span
            aria-hidden
            className="inline-flex h-[1.625rem] shrink-0 items-center rounded-md border border-primary/45 bg-primary/15 px-2 font-mono text-xs tracking-[0.06em] text-brand-200"
          >
            in
          </span>
        ) : null}
        <input
          ref={input}
          id={id}
          type="search"
          dir="auto"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          maxLength={200 + (content ? CONTENT_PREFIX.length : 0)}
          aria-label={
            content ? 'Search page contents' : 'Search titles and paths'
          }
          aria-describedby={content ? hintId : undefined}
          placeholder={
            content ? 'Search page contents' : 'Search titles and paths'
          }
          value={rest}
          onChange={(event) =>
            typed(event.target.value, event.target.selectionStart)
          }
          onKeyDown={keyDown}
          className="h-10 min-w-0 flex-1 bg-transparent text-base text-neutral-100 outline-none placeholder:text-neutral-400 md:h-9 md:text-sm [&::-webkit-search-cancel-button]:hidden"
        />
        {value === '' ? null : (
          <kbd
            aria-hidden
            className="shrink-0 rounded-[0.3125rem] border border-border px-1.5 py-0.5 font-mono text-[0.625rem] text-neutral-400"
          >
            esc
          </kbd>
        )}
      </label>
      {content ? (
        <p
          id={hintId}
          className="-mt-0.5 flex items-center gap-2 font-mono text-[0.625rem] tracking-[0.18em] text-brand-300 uppercase"
        >
          <FileText aria-hidden className="size-3 shrink-0" />
          Page contents
          <span className="sr-only"> · </span>
          <span className="ml-auto tracking-[0.1em] text-muted-foreground">
            backspace for titles
          </span>
        </p>
      ) : null}
    </div>
  )
})
