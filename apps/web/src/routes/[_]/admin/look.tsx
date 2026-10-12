import { createFileRoute, redirect } from '@tanstack/react-router'
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Eye,
  FileText,
  Folder,
  ImageUp,
  Lock,
  Search,
  Settings2,
  Upload,
} from 'lucide-react'
import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react'

import { AppHeader } from '../../../components/app-header'
import { NoAccessScreen } from '../../../components/no-access'
import { SectionLabel } from '../../../components/section-label'
import {
  ConfirmDialog,
  Note,
  Refusal,
  ROW,
} from '../../../components/settings-parts'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { Input, Label, Select } from '../../../components/ui/input'
import { cn } from '../../../lib/utils'
import {
  contrastChecks,
  DEFAULT_ROLES,
  familyOf,
  FONT_ROLES,
  headerName,
  logoUrl,
  lookCss,
  NAME_MAX,
  parseColor,
  RADIUS_MAX,
  ratioText,
  roleColor,
  ROLES,
  sameLook,
  scaleFrom,
  SCALES,
  STEPS,
  type FontChoice,
  type FontRole,
  type Look,
  type PresetName,
  type RoleName,
  type RoleValue,
  type ScaleName,
  type Step,
  type StepName,
} from '../../../lib/look'
import { isScreenFailure } from '../../../server/failure'
import {
  fetchGoogleFont,
  lookView,
  resetLook,
  saveLook,
  uploadFont,
  uploadLogo,
  type LookView,
} from '../../../server/look'
import { noAccessView } from '../../../server/no-access'

type Loaded =
  | { readonly kind: 'look'; readonly view: LookView }
  | { readonly kind: 'no-access'; readonly email: string | null }

/** What the screen says after the save or reset that reloaded it. */
type Done = 'saved' | 'reset'

export const Route = createFileRoute('/_/admin/look')({
  validateSearch: (search: Record<string, unknown>): { done?: Done } => ({
    done:
      search.done === 'saved' || search.done === 'reset'
        ? search.done
        : undefined,
  }),
  loader: async ({ location }): Promise<Loaded> => {
    const view = await lookView()
    if (!isScreenFailure(view)) return { kind: 'look', view }
    if (view.error.code === 'sign_in_required') {
      throw redirect({
        href: `/_/sign-in?next=${encodeURIComponent(location.href)}`,
      })
    }
    if (view.error.code !== 'not_found') throw new Error(view.error.message)
    const who = await noAccessView()
    return {
      kind: 'no-access',
      email: isScreenFailure(who) ? null : who.email,
    }
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title:
          loaderData?.kind === 'look'
            ? `Look · ${loaderData.view.deployment}`
            : 'Dossier',
      },
    ],
  }),
  component: LookRoute,
})

function LookRoute() {
  const loaded = Route.useLoaderData()
  return loaded.kind === 'no-access' ? (
    <NoAccessScreen email={loaded.email} />
  ) : (
    <LookScreen view={loaded.view} />
  )
}

/** The preview's container; its rules carry the unsaved Look. */
const PREVIEW = '[data-look-preview]'
/** Families of the unsaved Look, apart from the saved one's. */
const PREVIEW_FAMILY = 'Dossier Preview'

const ROLE_TITLES: Readonly<Record<FontRole, string>> = {
  display: 'Display',
  body: 'Body',
  mono: 'Mono',
  arabic: 'Arabic',
}

const SCALE_TITLES: Readonly<Record<ScaleName, string>> = {
  neutral: 'Neutral',
  brand: 'Brand',
  accent: 'Accent',
  complement: 'Complement',
  success: 'Success',
  warning: 'Warning',
  error: 'Error',
}

const DONE: Readonly<Record<Done, string>> = {
  saved: 'Saved. Every screen uses this Look from its next load.',
  reset: 'Dossier looks as agent964 again.',
}

/**
 * Loads the screen again after a save or reset: the browser keeps every
 * stylesheet React has added, so only a new document drops the old Look's.
 */
const reloadWith = (done: Done) => {
  window.location.replace(`${window.location.pathname}?done=${done}`)
}

function LookScreen({ view }: { view: LookView }) {
  const search = Route.useSearch()
  const saved = view.state
  const [draft, setDraft] = useState<Look>(view.state.look)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(
    search.done === undefined ? null : DONE[search.done],
  )
  const [resetting, setResetting] = useState(false)

  const checks = contrastChecks(draft)
  const readable = checks.every((check) => check.ok)
  const changed = !sameLook(draft, saved.look)

  const edit = (next: Look) => {
    setDraft(next)
    setDone(null)
    setRefused(null)
  }

  const save = async () => {
    setBusy(true)
    setRefused(null)
    const result = await saveLook({ data: { look: draft } })
    if (isScreenFailure(result)) {
      setRefused(result.error.message)
      setBusy(false)
      return
    }
    reloadWith('saved')
  }

  const reset = async (): Promise<string | null> => {
    const result = await resetLook()
    if (isScreenFailure(result)) return result.error.message
    reloadWith('reset')
    return null
  }

  return (
    <div className="min-h-dvh">
      <AppHeader
        email={view.email}
        beside={
          <span className="font-mono text-[0.6875rem] tracking-[0.2em] whitespace-nowrap text-neutral-400 uppercase">
            Super admin
          </span>
        }
      />
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 pt-6 pb-16 sm:px-6">
        <div className="flex flex-col gap-2">
          <p className="font-mono text-xs break-all text-neutral-500">
            {view.deployment} <span aria-hidden>/</span>{' '}
            <a
              href="/_/admin"
              className="rounded-sm underline-offset-4 outline-none hover:text-neutral-300 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              admin
            </a>{' '}
            <span aria-hidden>/</span>{' '}
            <span className="text-neutral-300">look</span>
          </p>
          <h1 className="font-clash text-[1.625rem] leading-tight font-semibold tracking-[-0.03em] text-neutral-50 sm:text-[1.875rem]">
            Look
          </h1>
          <p className="flex items-center gap-2 text-[0.9375rem] text-neutral-300">
            <Eye aria-hidden className="size-4 shrink-0 text-neutral-500" />
            How Dossier looks on this deployment.
          </p>
        </div>

        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_23rem]">
          <div className="flex min-w-0 flex-col gap-6">
            <Presets presets={view.presets} draft={draft} onChoose={edit} />
            <NameField
              value={draft.name}
              onChange={(name) => edit({ ...draft, name })}
            />
            <LogoField
              logo={draft.logo}
              onChange={(logo) => edit({ ...draft, logo })}
            />
            <Palette draft={draft} onChange={edit} />
            <Advanced draft={draft} onChange={edit} />
            <Contrast checks={checks} />
            <Fonts draft={draft} onChange={edit} />
            <Radius
              value={draft.radius}
              onChange={(radius) => edit({ ...draft, radius })}
            />
            <div className="flex flex-col gap-3">
              <Refusal message={refused} />
              {done === null ? null : (
                <p role="status" className="text-sm text-success-300">
                  {done}
                </p>
              )}
              <div className="flex flex-wrap items-center justify-end gap-2">
                {changed ? (
                  <span className="mr-auto font-mono text-xs text-neutral-400">
                    Unsaved changes
                  </span>
                ) : null}
                <Button
                  variant="ghost"
                  disabled={busy || !saved.custom}
                  onClick={() => setResetting(true)}
                >
                  Reset to agent964
                </Button>
                <Button
                  size="lg"
                  disabled={busy || !readable || !changed}
                  aria-describedby={readable ? undefined : 'contrast-label'}
                  onClick={save}
                >
                  Save
                </Button>
              </div>
            </div>
          </div>

          <LivePreview draft={draft} />
        </div>
      </main>
      <ConfirmDialog
        open={resetting}
        title="Reset to agent964?"
        description="Every screen of this deployment goes back to agent964's name, colours, fonts and radius. Copied fonts and logos stay stored."
        action="Reset"
        onConfirm={reset}
        onClose={() => setResetting(false)}
      />
    </div>
  )
}

function Presets({
  presets,
  draft,
  onChoose,
}: {
  presets: LookView['presets']
  draft: Look
  onChoose: (look: Look) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <span id="presets-label" className="text-sm font-medium text-neutral-300">
        Start from
      </span>
      <div
        role="group"
        aria-labelledby="presets-label"
        className="flex flex-wrap gap-1.5"
      >
        {(Object.keys(presets) as PresetName[]).map((name) => {
          const pressed = sameLook(draft, presets[name])
          return (
            <Button
              key={name}
              variant="outline"
              size="sm"
              aria-pressed={pressed}
              className={cn(
                pressed &&
                  'border-primary bg-primary/10 text-neutral-50 hover:bg-primary/15',
              )}
              onClick={() => onChoose(presets[name])}
            >
              {name}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

function NameField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="look-name">Name in the header</Label>
      <Input
        id="look-name"
        value={value}
        maxLength={NAME_MAX}
        placeholder="Dossier"
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

function LogoField({
  logo,
  onChange,
}: {
  logo: Look['logo']
  onChange: (logo: Look['logo']) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    setBusy(true)
    setRefused(null)
    const form = new FormData()
    form.set('file', file)
    const result = await uploadLogo({ data: form })
    if (isScreenFailure(result)) setRefused(result.error.message)
    else onChange(result)
    setBusy(false)
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-xl border border-border bg-card">
        <div className={ROW}>
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-neutral-800/70 text-neutral-300"
          >
            {logo === null ? (
              <ImageUp className="size-4" />
            ) : (
              <img
                src={logoUrl(logo)}
                alt=""
                className="size-full object-contain p-1"
              />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[0.9375rem] text-neutral-50">Logo</span>
            <span className="block font-mono text-xs text-neutral-400">
              {logo === null
                ? 'none, the name stands alone'
                : `${LOGO_NAMES[logo.type]}, beside the name`}
            </span>
          </span>
          {logo === null ? null : (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => onChange(null)}
            >
              Remove
            </Button>
          )}
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {busy ? 'Uploading…' : 'Upload'}
          </Button>
          <input
            ref={input}
            type="file"
            accept="image/png,image/webp,image/svg+xml,.png,.webp,.svg"
            className="sr-only"
            tabIndex={-1}
            aria-label="Upload a logo"
            onChange={choose}
          />
        </div>
      </div>
      <Refusal message={refused} />
    </div>
  )
}

const LOGO_NAMES: Readonly<Record<NonNullable<Look['logo']>['type'], string>> =
  {
    'image/png': 'PNG',
    'image/webp': 'WebP',
    'image/svg+xml': 'SVG',
  }

function Palette({
  draft,
  onChange,
}: {
  draft: Look
  onChange: (look: Look) => void
}) {
  const [open, setOpen] = useState<StepName | null>(null)
  const setScale = (scale: ScaleName, steps: Readonly<Record<Step, string>>) =>
    onChange({ ...draft, palette: { ...draft.palette, [scale]: steps } })
  return (
    <section aria-labelledby="palette-label" className="flex flex-col gap-3">
      <SectionLabel id="palette-label">Palette</SectionLabel>
      <p className="text-sm text-neutral-400">
        Seven scales of eleven steps. Choose a step to enter its colour as OKLCH
        or HEX.
      </p>
      <ul className="divide-y divide-border/80 rounded-xl border border-border bg-card">
        {SCALES.map((scale) => {
          const step =
            open !== null && open.startsWith(`${scale}-`)
              ? (Number(open.slice(scale.length + 1)) as Step)
              : null
          return (
            <li key={scale} className="flex flex-col gap-2 px-3.5 py-3">
              <ScaleRow
                scale={scale}
                steps={draft.palette[scale]}
                open={open}
                onOpen={(name) =>
                  setOpen((current) => (current === name ? null : name))
                }
              />
              {step === null ? null : (
                <StepEditor
                  key={open}
                  scale={scale}
                  step={step}
                  value={draft.palette[scale][step]}
                  onChange={(text) =>
                    setScale(scale, { ...draft.palette[scale], [step]: text })
                  }
                  onFill={(text) => setScale(scale, scaleFrom(text, step))}
                  onClose={() => setOpen(null)}
                />
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function ScaleRow({
  scale,
  steps,
  open,
  onOpen,
}: {
  scale: ScaleName
  steps: Readonly<Record<Step, string>>
  open: StepName | null
  onOpen: (step: StepName) => void
}) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
      <span
        id={`scale-${scale}`}
        className="font-mono text-xs text-neutral-300 sm:w-24 sm:shrink-0"
      >
        {SCALE_TITLES[scale]}
      </span>
      <div
        role="group"
        aria-labelledby={`scale-${scale}`}
        className="flex flex-1 flex-wrap gap-1"
      >
        {STEPS.map((step) => {
          const name: StepName = `${scale}-${step}`
          return (
            <button
              key={step}
              type="button"
              aria-label={`${name}, ${steps[step]}`}
              aria-pressed={open === name}
              title={`${name} · ${steps[step]}`}
              onClick={() => onOpen(name)}
              className={cn(
                'size-6 shrink-0 cursor-pointer rounded-md border border-foreground/20 outline-none transition-transform duration-200 ease-agent hover:scale-110 focus-visible:ring-[3px] focus-visible:ring-ring/60 motion-reduce:transition-none',
                open === name &&
                  'ring-2 ring-foreground ring-offset-2 ring-offset-card',
              )}
              style={{ background: parseColor(steps[step])?.css }}
            />
          )
        })}
      </div>
    </div>
  )
}

/** "oklch(70.00% 0.2000 0.0)", what a typed colour reads as. */
const readsAs = (color: NonNullable<ReturnType<typeof parseColor>>) => {
  const { l, c, h } = color.oklch
  const alpha = color.alpha < 1 ? ` / ${Math.round(color.alpha * 100)}%` : ''
  return `oklch(${(l * 100).toFixed(2)}% ${c.toFixed(4)} ${h.toFixed(1)}${alpha})`
}

/** One step's colour: typed as OKLCH or HEX, applied as soon as it parses. */
function StepEditor({
  scale,
  step,
  value,
  onChange,
  onFill,
  onClose,
}: {
  scale: ScaleName
  step: Step
  value: string
  onChange: (text: string) => void
  onFill: (text: string) => void
  onClose: () => void
}) {
  const id = useId()
  const [text, setText] = useState(value)
  const parsed = parseColor(text)
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-neutral-800/40 p-3">
      <Label htmlFor={id} className="font-mono text-xs">
        {scale}-{step}
      </Label>
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="size-10 shrink-0 rounded-lg border border-foreground/20"
          style={{ background: parsed?.css }}
        />
        <Input
          id={id}
          value={text}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="font-mono"
          aria-invalid={parsed === null ? true : undefined}
          aria-describedby={`${id}-reads`}
          onChange={(event) => {
            setText(event.target.value)
            if (parseColor(event.target.value) !== null) {
              onChange(event.target.value.trim())
            }
          }}
        />
      </div>
      <p
        id={`${id}-reads`}
        className={cn(
          'font-mono text-xs break-all',
          parsed === null ? 'text-error-300' : 'text-neutral-400',
        )}
      >
        {parsed === null
          ? 'Write OKLCH, such as oklch(70% 0.2 0), or HEX, such as #ff7ab6.'
          : `Reads as ${readsAs(parsed)}`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={parsed === null}
          onClick={() => onFill(text.trim())}
        >
          Fill the scale from this colour
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  )
}

const roleDefaultText = (role: RoleName) => {
  const value = DEFAULT_ROLES[role]
  if ('color' in value) return value.color
  return value.alpha === undefined
    ? value.step
    : `${value.step} at ${Math.round(value.alpha * 100)}%`
}

function Advanced({
  draft,
  onChange,
}: {
  draft: Look
  onChange: (look: Look) => void
}) {
  const setRole = (role: RoleName, value: RoleValue | null) => {
    const roles = { ...draft.roles }
    if (value === null) delete roles[role]
    else roles[role] = value
    onChange({ ...draft, roles })
  }
  return (
    <details className="group rounded-xl border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-3.5 py-3 text-[0.9375rem] text-neutral-50 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <Settings2 aria-hidden className="size-4 shrink-0 text-neutral-400" />
        <span className="min-w-0 flex-1">
          Advanced
          <span className="block font-mono text-xs text-neutral-400">
            the step or colour each role uses
          </span>
        </span>
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 text-neutral-400 transition-transform duration-200 ease-agent group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <ul className="divide-y divide-border/80 border-t border-border/80">
        {ROLES.map((role) => (
          <RoleRow
            key={role}
            role={role}
            draft={draft}
            onChange={(value) => setRole(role, value)}
          />
        ))}
      </ul>
    </details>
  )
}

const OWN_COLOUR = 'own'

function RoleRow({
  role,
  draft,
  onChange,
}: {
  role: RoleName
  draft: Look
  onChange: (value: RoleValue | null) => void
}) {
  const id = useId()
  const value = draft.roles[role]
  const choice =
    value === undefined ? '' : 'color' in value ? OWN_COLOUR : value.step
  const [text, setText] = useState(
    value !== undefined && 'color' in value ? value.color : '',
  )
  return (
    <li className="flex flex-col gap-2 px-3.5 py-2.5 sm:flex-row sm:items-center sm:gap-3">
      <span className="flex min-w-0 items-center gap-2 sm:w-48 sm:shrink-0">
        <span
          aria-hidden
          className="size-4 shrink-0 rounded-sm border border-foreground/20"
          style={{ background: roleColor(draft, role).css }}
        />
        <label
          htmlFor={id}
          className="truncate font-mono text-xs text-neutral-200"
        >
          {role}
        </label>
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Select
          id={id}
          value={choice}
          onChange={(event) => {
            const next = event.target.value
            if (next === '') onChange(null)
            else if (next === OWN_COLOUR) {
              const start = text === '' ? roleColor(draft, role).css : text
              setText(start)
              onChange({ color: start })
            } else onChange({ step: next as StepName })
          }}
        >
          <option value="">Default: {roleDefaultText(role)}</option>
          {SCALES.map((scale) => (
            <optgroup key={scale} label={SCALE_TITLES[scale]}>
              {STEPS.map((step) => (
                <option key={step} value={`${scale}-${step}`}>
                  {scale}-{step}
                </option>
              ))}
            </optgroup>
          ))}
          <option value={OWN_COLOUR}>A colour of its own</option>
        </Select>
        {choice === OWN_COLOUR ? (
          <Input
            aria-label={`${role} colour, OKLCH or HEX`}
            value={text}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono"
            aria-invalid={parseColor(text) === null ? true : undefined}
            onChange={(event) => {
              setText(event.target.value)
              if (parseColor(event.target.value) !== null) {
                onChange({ color: event.target.value.trim() })
              }
            }}
          />
        ) : null}
      </div>
    </li>
  )
}

function Contrast({ checks }: { checks: ReturnType<typeof contrastChecks> }) {
  return (
    <section aria-labelledby="contrast-label" className="flex flex-col gap-3">
      <SectionLabel id="contrast-label">Contrast</SectionLabel>
      <ul
        aria-live="polite"
        className="divide-y divide-border/80 rounded-xl border border-border bg-card"
      >
        {checks.map((check) => (
          <li
            key={check.pair}
            className="flex min-h-11 items-center gap-3 px-3.5 py-2"
          >
            <span className="min-w-0 flex-1 text-[0.9375rem] text-neutral-100">
              {check.pair}
            </span>
            {check.ok ? null : (
              <span className="flex items-center gap-1 text-xs text-error-300">
                <CircleAlert aria-hidden className="size-3.5" />
                needs 4.5:1
              </span>
            )}
            <span
              className={cn(
                'font-mono text-sm tabular-nums',
                check.ok ? 'text-neutral-300' : 'text-error-300',
              )}
            >
              {ratioText(check.ratio)}
            </span>
          </li>
        ))}
      </ul>
      {checks.every((check) => check.ok) ? null : (
        <Note>
          Each pair needs at least 4.5:1 so everyone can read it. Save is off
          until they all do.
        </Note>
      )}
    </section>
  )
}

function Fonts({
  draft,
  onChange,
}: {
  draft: Look
  onChange: (look: Look) => void
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
            onChange={(choice) =>
              onChange({ ...draft, fonts: { ...draft.fonts, [role]: choice } })
            }
          />
        ))}
      </ul>
      <Note>
        A Google font is copied to this deployment when you fetch it, so no
        screen ever asks Google for anything.
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
  onChange,
}: {
  role: FontRole
  choice: FontChoice
  onChange: (choice: FontChoice) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [family, setFamily] = useState('')
  const [busy, setBusy] = useState<'fetch' | 'upload' | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const [changing, setChanging] = useState(false)
  const title = ROLE_TITLES[role]
  const actions = useId()

  const fetchFamily = async (event: FormEvent) => {
    event.preventDefault()
    setBusy('fetch')
    setRefused(null)
    const result = await fetchGoogleFont({ data: { family } })
    if (isScreenFailure(result)) setRefused(result.error.message)
    else {
      onChange(result)
      setFamily('')
      setChanging(false)
    }
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
    const result = await uploadFont({ data: form })
    if (isScreenFailure(result)) setRefused(result.error.message)
    else {
      onChange(result)
      setChanging(false)
    }
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
          variant="outline"
          size="xs"
          aria-expanded={changing}
          aria-controls={actions}
          aria-label={`Change the ${title} font`}
          onClick={() => setChanging((open) => !open)}
        >
          {changing ? 'Close' : 'Change'}
        </Button>
      </div>
      <div id={actions} hidden={!changing} className="flex flex-col gap-3">
        <form onSubmit={fetchFamily} className="flex gap-2">
          <Input
            aria-label={`Google Fonts family for ${title}`}
            placeholder="Google Fonts family, such as Inter"
            value={family}
            required
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setFamily(event.target.value)}
          />
          <Button
            type="submit"
            variant="secondary"
            size="lg"
            disabled={busy !== null}
            aria-label={`Fetch from Google Fonts for ${title}`}
          >
            {busy === 'fetch' ? 'Fetching…' : 'Fetch'}
          </Button>
        </form>
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
              setChanging(false)
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

function Radius({
  value,
  onChange,
}: {
  value: number
  onChange: (value: number) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="look-radius">Corner radius</Label>
        <code className="font-mono text-xs text-neutral-400">{value} px</code>
      </div>
      <input
        id="look-radius"
        type="range"
        min={0}
        max={RADIUS_MAX}
        step={1}
        value={value}
        aria-valuetext={`${value} px`}
        className="h-6 w-full cursor-pointer accent-primary"
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  )
}

/**
 * The home with sample rows, inside a container that carries the unsaved
 * variables and font faces. It follows every change before Save.
 */
function LivePreview({ draft }: { draft: Look }) {
  const css = lookCss(draft, { scope: PREVIEW, prefix: PREVIEW_FAMILY })
  return (
    <figure className="m-0 flex flex-col gap-2 lg:sticky lg:top-6">
      <figcaption className="text-center font-mono text-[0.6875rem] tracking-[0.2em] text-neutral-400 uppercase">
        Live preview, the home
      </figcaption>
      {/* Written from the parsed Look only: every colour is rewritten from
          its parsed value and every family name is the preview's own. */}
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div
        data-look-preview
        inert
        className="mx-auto w-full max-w-[23rem] overflow-hidden rounded-[calc(var(--radius)+14px)] border border-border shadow-[0_18px_44px_rgba(0,0,0,0.28)]"
        style={{
          backgroundImage:
            'radial-gradient(120% 55% at 50% -12%, color-mix(in oklab, var(--primary) 11%, transparent), transparent 62%)',
        }}
      >
        <div className="px-3 pt-3">
          <div className="chrome-glass flex h-12 items-center gap-2 rounded-xl px-3.5">
            {draft.logo === null ? null : (
              <img
                src={logoUrl(draft.logo)}
                alt=""
                className="h-6 w-auto max-w-20 shrink-0 object-contain"
              />
            )}
            <span className="min-w-0 truncate font-clash text-[1.0625rem] font-semibold tracking-[-0.02em] text-neutral-50">
              {headerName(draft)}
            </span>
            <span aria-hidden className="text-neutral-600">
              /
            </span>
            <span className="flex min-w-0 items-center gap-1 font-mono text-sm text-neutral-100">
              <span className="truncate">agent964</span>
              <ChevronDown className="size-3.5 shrink-0 text-neutral-400" />
            </span>
            <span className="ml-auto flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-neutral-900/60">
              <span className="flex size-6 items-center justify-center rounded-md bg-neutral-700 text-xs font-semibold text-neutral-100 uppercase">
                s
              </span>
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-4 px-4 pt-5 pb-6">
          <p className="font-clash text-[1.75rem] leading-tight font-semibold tracking-[-0.03em] text-neutral-50">
            agent964
          </p>
          <div className="flex h-10 items-center gap-2 rounded-lg border border-border bg-input px-3 text-sm text-muted-foreground">
            <Search className="size-4 shrink-0" />
            Search titles and paths
          </div>
          <SectionLabel count={3}>Trees</SectionLabel>
          <PreviewRows>
            <PreviewRow
              icon={<Folder className="size-4" />}
              title="t964os/"
              detail="Shared with the workspace"
              end={<ChevronRight className="size-4 text-neutral-500" />}
              mono
            />
            <PreviewRow
              icon={<Folder className="size-4" />}
              title="acme/"
              detail="Shared with 3 people"
              end={<ChevronRight className="size-4 text-neutral-500" />}
              mono
            />
            <PreviewRow
              icon={<Folder className="size-4" />}
              title="personal/"
              detail="Private"
              end={<Lock className="size-3.5 text-neutral-500" />}
              mono
            />
          </PreviewRows>
          <SectionLabel count={2}>Shared with me</SectionLabel>
          <PreviewRows>
            <PreviewRow
              icon={<FileText className="size-4" />}
              tone="complement"
              title="Onboarding form"
              detail="from acme.dev · 12 Oct"
              badge={<Badge variant="accent">waiting for your answer</Badge>}
              end={<RoleText>Respond</RoleText>}
            />
            <PreviewRow
              icon={<FileText className="size-4" />}
              tone="primary"
              title="Delivery terms"
              detail="from acme.dev · 9 Oct"
              badge={<Badge>mentioned you</Badge>}
              end={<RoleText>Read</RoleText>}
            />
          </PreviewRows>
          <p dir="rtl" lang="ar" className="text-sm text-neutral-300">
            خطة التسليم · ٣ صفحات
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" tabIndex={-1}>
              Open
            </Button>
            <Button variant="outline" size="sm" tabIndex={-1}>
              Use another Google account
            </Button>
          </div>
        </div>
      </div>
    </figure>
  )
}

function PreviewRows({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-border/80 overflow-hidden rounded-xl border border-border bg-card">
      {children}
    </div>
  )
}

function RoleText({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[0.625rem] tracking-[0.14em] text-muted-foreground uppercase">
      {children}
    </span>
  )
}

function PreviewRow({
  icon,
  title,
  detail,
  end,
  badge,
  tone,
  mono = false,
}: {
  icon: ReactNode
  title: string
  detail: string
  end: ReactNode
  badge?: ReactNode
  tone?: 'primary' | 'complement'
  mono?: boolean
}) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-3">
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-neutral-800/70 text-neutral-300',
          tone === 'primary' && 'bg-primary/10 text-primary',
          tone === 'complement' && 'bg-complement-400/10 text-complement-400',
        )}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            'truncate text-[0.9375rem] text-neutral-50',
            mono && 'font-mono',
          )}
        >
          {title}
        </span>
        <span className="truncate text-xs text-neutral-400">{detail}</span>
        {badge === undefined ? null : <span className="mt-1">{badge}</span>}
      </span>
      {end}
    </div>
  )
}
