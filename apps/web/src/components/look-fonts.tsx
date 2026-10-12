import { Search, Upload } from 'lucide-react'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react'

import {
  loadGoogleFamilies,
  searchFamilies,
  type GoogleFamily,
} from '../lib/font-search'
import {
  familyOf,
  FONT_ROLES,
  type FontChoice,
  type FontRole,
  type Look,
} from '../lib/look'
import { cn } from '../lib/utils'
import { SectionLabel } from './section-label'
import { Note, Refusal } from './settings-parts'
import { Button } from './ui/button'
import { Input } from './ui/input'

/** Families of the unsaved Look, apart from the saved one's. */
export const PREVIEW_FAMILY = 'Dossier Preview'

/** What the font rows ask of the deployment: a choice, or why it refused. */
export interface FontActions {
  /** Copies a Google Fonts family to the deployment. */
  readonly copyGoogleFont: (family: string) => Promise<FontChoice | string>
  /** FormData with `file` and `family`. */
  readonly uploadFont: (form: FormData) => Promise<FontChoice | string>
}

const ROLE_TITLES: Readonly<Record<FontRole, string>> = {
  display: 'Display',
  body: 'Body',
  mono: 'Mono',
  arabic: 'Arabic',
}

export function Fonts({
  draft,
  onChange,
  actions,
}: {
  draft: Look
  onChange: (look: Look) => void
  actions: FontActions
}) {
  return (
    <section aria-labelledby="fonts-label" className="flex flex-col gap-3">
      <SectionLabel id="fonts-label">Fonts</SectionLabel>
      <ul className="divide-y divide-border/80 rounded-xl border border-border bg-card">
        {FONT_ROLES.map((role) => (
          <FontRoleRow
            key={role}
            role={role}
            choice={draft.fonts[role]}
            actions={actions}
            onChange={(choice) =>
              onChange({ ...draft, fonts: { ...draft.fonts, [role]: choice } })
            }
          />
        ))}
      </ul>
      <Note>
        The list shows each family from Google Fonts while you browse it here.
        The family you choose is copied to this deployment, so no other screen
        ever asks Google for anything.
      </Note>
    </section>
  )
}

const SAMPLE: Readonly<Record<FontRole, string>> = {
  display: 'Ag',
  body: 'Ag',
  mono: '{}',
  arabic: 'أب',
}

/** A name for an uploaded file's family, from the file's own name. */
const familyFromFile = (name: string) =>
  name
    .replace(/\.[^.]+$/, '')
    .replace(/[^\p{L}\p{N} .\-_]+/gu, ' ')
    .trim()
    .slice(0, 64) || 'Uploaded font'

const SOURCES: Readonly<Record<FontChoice['kind'], string>> = {
  agent964: 'agent964’s',
  system: 'this device’s own',
  google: 'Google Fonts, copied here',
  upload: 'uploaded',
}

function FontRoleRow({
  role,
  choice,
  actions,
  onChange,
}: {
  role: FontRole
  choice: FontChoice
  actions: FontActions
  onChange: (choice: FontChoice) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const change = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState<'copy' | 'upload' | null>(null)
  const [copying, setCopying] = useState<string | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const [changing, setChanging] = useState(false)
  const title = ROLE_TITLES[role]
  const panel = useId()

  const close = () => {
    setChanging(false)
    change.current?.focus()
  }

  const take = (result: FontChoice | string) => {
    if (typeof result === 'string') setRefused(result)
    else {
      onChange(result)
      close()
    }
  }

  const copy = async (family: string) => {
    if (busy !== null) return
    setBusy('copy')
    setCopying(family)
    setRefused(null)
    take(await actions.copyGoogleFont(family))
    setCopying(null)
    setBusy(null)
  }

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    setBusy('upload')
    setRefused(null)
    const form = new FormData()
    form.set('file', file)
    form.set('family', familyFromFile(file.name))
    take(await actions.uploadFont(form))
    setBusy(null)
  }

  return (
    <li className="flex flex-col gap-3 px-3.5 py-3">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          lang={role === 'arabic' ? 'ar' : undefined}
          className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-neutral-800/70 text-lg text-neutral-50"
          style={{ fontFamily: `"${PREVIEW_FAMILY} ${title}"` }}
        >
          {SAMPLE[role]}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[0.9375rem] text-neutral-50">
            {title}
          </span>
          <span className="block truncate font-mono text-xs text-neutral-400">
            {familyOf(role, choice)} · {SOURCES[choice.kind]}
          </span>
        </span>
        <Button
          ref={change}
          variant="outline"
          size="xs"
          aria-expanded={changing}
          aria-controls={panel}
          aria-label={
            changing
              ? `Close the ${title} font list`
              : `Change the ${title} font`
          }
          onClick={() => {
            setRefused(null)
            setChanging((open) => !open)
          }}
        >
          {changing ? 'Close' : 'Change'}
        </Button>
      </div>
      <div id={panel} hidden={!changing} className="flex flex-col gap-3">
        {changing ? (
          <FamilySearch
            role={role}
            title={title}
            copying={copying}
            onChoose={copy}
            onClose={close}
          />
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            aria-label={`Upload a font file for ${title}`}
            onClick={() => input.current?.click()}
          >
            <Upload aria-hidden />
            {busy === 'upload' ? 'Uploading…' : 'Upload a font file'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={
              busy !== null ||
              (choice.kind === 'agent964' && choice.face === undefined)
            }
            aria-label={`Use agent964's font for ${title}`}
            onClick={() => {
              onChange({ kind: 'agent964' })
              close()
            }}
          >
            Use agent964&apos;s
          </Button>
          <input
            ref={input}
            type="file"
            accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
            className="sr-only"
            tabIndex={-1}
            aria-label={`Font file for ${title}`}
            onChange={upload}
          />
        </div>
      </div>
      <Refusal message={refused} />
    </li>
  )
}

/** Families shown at once; typing narrows the rest. */
const SHOWN = 50

const ARABIC_SAMPLE = 'أبجد هوز'

const GENERIC: Readonly<Record<string, string>> = {
  Serif: 'serif',
  Monospace: 'monospace',
  Handwriting: 'cursive',
}

const previewed = new Set<string>()

/**
 * Loads just the glyphs of a family's name (and its Arabic sample) from
 * Google Fonts, once per page, so the option shows in its own typeface.
 */
const loadPreview = ([family, , arabic]: GoogleFamily) => {
  if (previewed.has(family)) return
  previewed.add(family)
  const text = [...new Set(family + (arabic ? ARABIC_SAMPLE : ''))].join('')
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?family=${family.replaceAll(' ', '+')}&text=${encodeURIComponent(text)}&display=swap`
  document.head.appendChild(link)
}

const familiesText = (count: number) =>
  count === 1 ? '1 family' : `${count.toLocaleString('en')} families`

/**
 * A combobox over the Google Fonts catalogue: the families narrow by fuzzy
 * search as the person types, each shown in its own typeface, and choosing
 * one (Enter, or a click) copies it.
 */
function FamilySearch({
  role,
  title,
  copying,
  onChoose,
  onClose,
}: {
  role: FontRole
  title: string
  copying: string | null
  onChoose: (family: string) => void
  onClose: () => void
}) {
  const field = useRef<HTMLInputElement>(null)
  const [families, setFamilies] = useState<readonly GoogleFamily[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)
  const id = useId()
  const listId = `${id}-families`
  const optionId = (index: number) => `${id}-family-${index}`

  useEffect(() => {
    field.current?.focus()
    let live = true
    loadGoogleFamilies().then(
      (loaded) => live && setFamilies(loaded),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [])

  const matches = useMemo(
    () => (families === null ? [] : searchFamilies(families, query, role)),
    [families, query, role],
  )
  const shown = matches.slice(0, SHOWN)
  const current = active < shown.length ? active : -1

  useEffect(() => {
    if (current < 0) return
    document
      .getElementById(`${id}-family-${current}`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [current, id])

  const typed = query.trim() !== ''
  const status =
    copying !== null
      ? `Copying ${copying} to this deployment…`
      : failed
        ? 'The list of Google Fonts did not load. Reload the page to try again.'
        : families === null
          ? 'Loading Google Fonts…'
          : !typed
            ? `${familiesText(matches.length)} on Google Fonts, most used first. Type to search them.`
            : matches.length === 0
              ? `No Google Fonts family matches “${query.trim()}”.`
              : `${familiesText(matches.length)} match${matches.length === 1 ? 'es' : ''}${matches.length > SHOWN ? `, the first ${SHOWN} shown. Keep typing to narrow.` : '.'}`

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        if (shown.length > 0) {
          setActive(Math.min(current + 1, shown.length - 1))
        }
        break
      case 'ArrowUp':
        event.preventDefault()
        if (shown.length > 0) setActive(Math.max(current - 1, 0))
        break
      case 'Enter': {
        event.preventDefault()
        const entry = shown[current]
        if (entry !== undefined) onChoose(entry[0])
        break
      }
      case 'Escape':
        event.preventDefault()
        if (query !== '') {
          setQuery('')
          setActive(-1)
        } else onClose()
        break
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-neutral-400"
        />
        <Input
          ref={field}
          role="combobox"
          aria-label={`Google Fonts family for ${title}`}
          aria-expanded={shown.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={current < 0 ? undefined : optionId(current)}
          aria-describedby={`${id}-status`}
          placeholder="Search Google Fonts"
          value={query}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="pl-9"
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(event.target.value.trim() === '' ? -1 : 0)
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <p
        id={`${id}-status`}
        role="status"
        className="font-mono text-xs text-neutral-400"
      >
        {status}
      </p>
      <ul
        id={listId}
        role="listbox"
        aria-label={`Google Fonts families for ${title}`}
        aria-busy={copying !== null}
        hidden={shown.length === 0}
        className="max-h-72 overflow-y-auto overscroll-contain rounded-lg border border-border bg-neutral-900/60 py-1"
      >
        {shown.map((entry, index) => (
          <FamilyOption
            key={entry[0]}
            id={optionId(index)}
            entry={entry}
            role={role}
            active={index === current}
            onChoose={onChoose}
          />
        ))}
      </ul>
    </div>
  )
}

function FamilyOption({
  id,
  entry,
  role,
  active,
  onChoose,
}: {
  id: string
  entry: GoogleFamily
  role: FontRole
  active: boolean
  onChoose: (family: string) => void
}) {
  const option = useRef<HTMLLIElement>(null)
  const [family, category, arabic] = entry

  // Only an option scrolled into sight loads its preview.
  useEffect(() => {
    const element = option.current
    if (element === null || typeof IntersectionObserver === 'undefined') {
      return
    }
    const observer = new IntersectionObserver((seen) => {
      if (seen.some((item) => item.isIntersecting)) {
        loadPreview(entry)
        observer.disconnect()
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [entry])

  return (
    <li
      ref={option}
      id={id}
      role="option"
      aria-selected={active}
      data-family={family}
      className={cn(
        'flex min-h-11 cursor-pointer items-center gap-3 px-3 py-1.5 text-neutral-50 hover:bg-neutral-800/70',
        active && 'bg-primary/10 shadow-[inset_2px_0_0_var(--primary)]',
      )}
      // Keeps focus in the search field, so the keyboard goes on working.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onChoose(family)}
    >
      <span
        data-preview
        className="min-w-0 flex-1 truncate text-[1.0625rem]"
        style={{
          fontFamily: `"${family}", ${GENERIC[category] ?? 'sans-serif'}`,
        }}
      >
        {family}
        {role === 'arabic' && arabic ? (
          <span lang="ar" dir="rtl" className="ml-2">
            {ARABIC_SAMPLE}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 font-mono text-[0.6875rem] text-neutral-400">
        {category}
      </span>
    </li>
  )
}
