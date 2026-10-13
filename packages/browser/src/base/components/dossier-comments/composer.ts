// One place to write: a labelled textarea that suggests people and teams to
// mention as @ is typed, room for the controls its caller adds, and its
// buttons. And the status line each place reports to. Every control carries
// a data-key, so the component finds it again after a re-render and keeps
// focus there.
import type { Mentionable, MentionablePerson } from '@dossier/contracts/bridge'
import {
  mentionAt,
  searchOf,
  suggestionsFor,
  suggestionText,
  type Suggestion,
} from './threads.ts'

let counter = 0
/** An id unique in the document. */
export const uid = (part: string): string =>
  `dossier-comments-${(counter += 1)}-${part}`

export const button = (
  document: Document,
  text: string,
  key: string,
  extra = '',
): HTMLButtonElement => {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = `dossier-comments-button${extra === '' ? '' : ` ${extra}`}`
  element.textContent = text
  element.setAttribute('data-key', key)
  return element
}

export interface ComposerOptions {
  readonly document: Document
  /** Names its controls: 'main', 'reply:<root>', 'edit:<path>'. */
  readonly key: string
  readonly label: string
  /** The label is read out but not shown. */
  readonly hideLabel?: boolean
  readonly submitLabel: string
  readonly cancelLabel?: string
  /** The people in the threads, to suggest after @. */
  readonly known: () => readonly MentionablePerson[]
  /**
   * Whom Dossier suggests for what follows the @: its answer when one is
   * known, else null, and `ready` is called once it comes.
   */
  readonly lookup?: (query: string, ready: () => void) => Mentionable | null
  readonly onSubmit: () => void
  readonly onCancel?: () => void
}

/** A textarea with suggestions, extra controls and its buttons. */
export class Composer {
  readonly form: HTMLFormElement
  readonly textarea: HTMLTextAreaElement
  /** Where the caller adds its own controls. */
  readonly extras: HTMLDivElement
  readonly submit: HTMLButtonElement
  readonly cancel: HTMLButtonElement | null
  readonly #options: ComposerOptions
  readonly #list: HTMLUListElement
  readonly #count: HTMLSpanElement
  #shown: Suggestion[] = []
  #active = -1
  #busy = false
  /**
   * Bumped when the suggestions are put away (Escape, leaving, choosing,
   * sending): an answer asked for before then shows nothing. What is typed
   * or clicked next asks afresh.
   */
  #dismissals = 0

  constructor(options: ComposerOptions) {
    this.#options = options
    const doc = options.document
    const form = doc.createElement('form')
    form.className = 'dossier-comments-composer'
    form.noValidate = true
    form.setAttribute('data-composer', options.key)
    const textareaId = uid('text')
    const label = doc.createElement('label')
    label.className = options.hideLabel
      ? 'dossier-comments-hidden'
      : 'dossier-comments-label'
    label.htmlFor = textareaId
    label.textContent = options.label
    const textarea = doc.createElement('textarea')
    textarea.id = textareaId
    textarea.className = 'dossier-comments-input'
    textarea.dir = 'auto'
    textarea.rows = 3
    textarea.setAttribute('data-key', `text:${options.key}`)
    const listId = uid('people')
    textarea.setAttribute('aria-autocomplete', 'list')
    textarea.setAttribute('aria-controls', listId)
    const list = doc.createElement('ul')
    list.id = listId
    list.className = 'dossier-comments-suggestions'
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', 'People to mention')
    list.hidden = true
    const count = doc.createElement('span')
    count.className = 'dossier-comments-hidden'
    count.setAttribute('aria-live', 'polite')
    const extras = doc.createElement('div')
    extras.className = 'dossier-comments-options'
    const actions = doc.createElement('div')
    actions.className = 'dossier-comments-actions'
    const submit = button(
      doc,
      options.submitLabel,
      `send:${options.key}`,
      'dossier-comments-primary',
    )
    submit.type = 'submit'
    actions.append(submit)
    let cancel: HTMLButtonElement | null = null
    if (options.cancelLabel !== undefined) {
      cancel = button(doc, options.cancelLabel, `cancel:${options.key}`)
      cancel.addEventListener('click', () => options.onCancel?.())
      actions.append(cancel)
    }
    form.append(label, textarea, list, count, extras, actions)
    this.form = form
    this.textarea = textarea
    this.extras = extras
    this.submit = submit
    this.cancel = cancel
    this.#list = list
    this.#count = count

    // Not a managed form: nothing leaves the page by itself.
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (!this.#busy) options.onSubmit()
    })
    textarea.addEventListener('input', () => {
      this.setInvalid(false)
      this.#suggest()
    })
    textarea.addEventListener('keydown', (event) => this.#key(event))
    textarea.addEventListener('blur', () => {
      // A tap on a suggestion keeps focus, so leaving means done.
      this.#dismiss()
    })
    textarea.addEventListener('click', () => this.#suggest())
  }

  get text(): string {
    return this.textarea.value
  }

  set text(value: string) {
    this.textarea.value = value
    this.#dismiss()
  }

  get busy(): boolean {
    return this.#busy
  }

  /** While a send goes, the button stays focusable but does nothing. */
  setBusy(busy: boolean): void {
    this.#busy = busy
    if (busy) {
      this.submit.setAttribute('aria-disabled', 'true')
      this.form.setAttribute('aria-busy', 'true')
    } else {
      this.submit.removeAttribute('aria-disabled')
      this.form.removeAttribute('aria-busy')
    }
  }

  setInvalid(invalid: boolean): void {
    if (invalid) this.textarea.setAttribute('aria-invalid', 'true')
    else this.textarea.removeAttribute('aria-invalid')
  }

  /** The textarea's description: the status line it reports to. */
  describedBy(id: string): void {
    this.textarea.setAttribute('aria-describedby', id)
  }

  focus(): void {
    this.textarea.focus({ preventScroll: false })
  }

  #key(event: KeyboardEvent): void {
    if (event.isComposing) return
    const open = !this.#list.hidden
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      this.#dismiss()
      if (!this.#busy) this.#options.onSubmit()
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const size = this.#shown.length
      this.#activate((this.#active + step + size) % size)
    } else if (event.key === 'Enter' && this.#active >= 0) {
      event.preventDefault()
      this.#accept(this.#shown[this.#active]!)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      this.#dismiss()
    }
  }

  /**
   * Shows the people in the threads and those Dossier suggests, and its
   * teams, matching the @ before the caret.
   */
  #suggest(): void {
    const textarea = this.textarea
    const at =
      textarea.selectionStart === textarea.selectionEnd
        ? mentionAt(textarea.value, textarea.selectionStart)
        : null
    // Dossier's answer for this @ when it has one; the threads' at once.
    const dismissals = this.#dismissals
    const found =
      at === null
        ? null
        : (this.#options.lookup?.(searchOf(at.query).text, () =>
            this.#again(at.query, dismissals),
          ) ?? null)
    const shown =
      at === null ? [] : suggestionsFor(this.#options.known(), found, at.query)
    if (
      shown.length === 0 ||
      (shown.length === 1 &&
        suggestionText(shown[0]!).toLowerCase() ===
          `@${at?.query.toLowerCase()}`)
    ) {
      this.#close()
      return
    }
    const before = this.#shown[this.#active]
    this.#shown = shown
    this.#list.replaceChildren(
      ...shown.map((suggestion, index) => this.#option(suggestion, index)),
    )
    this.#list.hidden = false
    const keep =
      before === undefined
        ? -1
        : shown.findIndex((s) => suggestionText(s) === suggestionText(before))
    this.#activate(keep >= 0 ? keep : 0)
    const teams = shown.filter((s) => s.kind === 'team').length
    this.#count.textContent =
      shown.length === 1
        ? teams === 1
          ? '1 team to mention'
          : '1 person to mention'
        : teams === 0
          ? `${shown.length} people to mention`
          : `${shown.length} people and teams to mention`
  }

  /**
   * Dossier answered for `query`: shown if that @ is still being typed and
   * the suggestions were not put away since it was asked.
   */
  #again(query: string, dismissals: number): void {
    const textarea = this.textarea
    if (dismissals !== this.#dismissals) return
    if (this.#options.document.activeElement !== textarea) return
    const at =
      textarea.selectionStart === textarea.selectionEnd
        ? mentionAt(textarea.value, textarea.selectionStart)
        : null
    if (at !== null && at.query === query) this.#suggest()
  }

  /** One suggestion: a photo or initial, the name, and the email or team size. */
  #option(suggestion: Suggestion, index: number): HTMLLIElement {
    const doc = this.#options.document
    const option = doc.createElement('li')
    option.id = `${this.#list.id}-${index}`
    option.className = 'dossier-comments-suggestion'
    option.dir = 'auto'
    option.setAttribute('role', 'option')
    option.setAttribute('aria-selected', 'false')
    option.setAttribute('data-mention', suggestionText(suggestion))
    const avatar = doc.createElement('span')
    avatar.className = 'dossier-comments-avatar'
    avatar.setAttribute('aria-hidden', 'true')
    const title =
      suggestion.kind === 'person'
        ? (suggestion.name ?? suggestion.email)
        : suggestion.name
    const initial = Array.from(title)[0] ?? '?'
    avatar.textContent = initial
    if (suggestion.kind === 'person' && suggestion.image !== null) {
      const photo = doc.createElement('img')
      photo.alt = ''
      photo.referrerPolicy = 'no-referrer'
      photo.decoding = 'async'
      // A photo that does not load leaves the initial.
      photo.addEventListener('error', () => {
        avatar.textContent = initial
      })
      photo.src = suggestion.image
      avatar.replaceChildren(photo)
    }
    const name = doc.createElement('span')
    name.className = 'dossier-comments-suggestion-name'
    name.textContent = title
    const detail = doc.createElement('span')
    detail.className = 'dossier-comments-suggestion-detail'
    detail.textContent =
      suggestion.kind === 'team'
        ? `Team · ${suggestion.members === 1 ? '1 person' : `${suggestion.members} people`}`
        : suggestion.name === null
          ? ''
          : suggestion.email
    detail.hidden = detail.textContent === ''
    option.append(avatar, name, detail)
    // Keeps focus in the textarea while the option is tapped.
    option.addEventListener('mousedown', (event) => event.preventDefault())
    option.addEventListener('click', () => this.#accept(suggestion))
    return option
  }

  #activate(index: number): void {
    this.#active = index
    const options = [...this.#list.children]
    options.forEach((option, at) => {
      option.setAttribute('aria-selected', at === index ? 'true' : 'false')
    })
    const active = options[index]
    if (active === undefined) {
      this.textarea.removeAttribute('aria-activedescendant')
      return
    }
    this.textarea.setAttribute('aria-activedescendant', active.id)
    if (typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' })
    }
  }

  #accept(suggestion: Suggestion): void {
    const textarea = this.textarea
    const caret = textarea.selectionStart
    const at = mentionAt(textarea.value, caret)
    if (at === null) {
      this.#close()
      return
    }
    const value = textarea.value
    const after = value.slice(caret)
    const insert = `${suggestionText(suggestion)}${/^\s/.test(after) ? '' : ' '}`
    textarea.value = `${value.slice(0, at.start)}${insert}${after}`
    const end = at.start + insert.length
    textarea.setSelectionRange(end, end)
    this.#dismiss()
    textarea.focus()
  }

  /** Puts the suggestions away: an answer still on its way shows nothing. */
  #dismiss(): void {
    this.#dismissals += 1
    this.#close()
  }

  #close(): void {
    if (this.#list.hidden && this.#shown.length === 0) return
    this.#list.hidden = true
    this.#list.replaceChildren()
    this.#shown = []
    this.#active = -1
    this.#count.textContent = ''
    this.textarea.removeAttribute('aria-activedescendant')
  }
}

/** A live line saying how the last send from one place went, with Try again. */
export class StatusLine {
  /** `.dossier-comments-feedback`: the line and its button. */
  readonly element: HTMLDivElement
  /** `.dossier-comments-status`, the live region. */
  readonly line: HTMLParagraphElement
  readonly retry: HTMLButtonElement
  /** A send from this place is under way. */
  busy = false
  #again: (() => void) | null = null
  readonly #home: () => HTMLElement | null

  /** `home` takes focus when Try again goes away while focused. */
  constructor(document: Document, key: string, home: () => HTMLElement | null) {
    this.#home = home
    const element = document.createElement('div')
    element.className = 'dossier-comments-feedback'
    const line = document.createElement('p')
    line.className = 'dossier-comments-status'
    line.dir = 'auto'
    line.id = uid('status')
    line.setAttribute('role', 'status')
    const retry = button(
      document,
      'Try again',
      `retry:${key}`,
      'dossier-comments-retry',
    )
    retry.hidden = true
    retry.addEventListener('click', () => this.#again?.())
    element.append(line, retry)
    this.element = element
    this.line = line
    this.retry = retry
  }

  get text(): string {
    return this.line.textContent ?? ''
  }

  /** Shows `text`, with Try again calling `again` once pressed. */
  say(text: string, again: (() => void) | null = null): void {
    this.line.textContent = text
    this.#again = again
    const hide = again === null
    if (hide && !this.retry.hidden) {
      const focused = this.retry.ownerDocument.activeElement === this.retry
      this.retry.hidden = true
      if (focused) this.#home()?.focus({ preventScroll: true })
    } else {
      this.retry.hidden = hide
    }
  }
}
