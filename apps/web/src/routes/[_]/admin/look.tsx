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
} from 'lucide-react'
import { useRef, useState, type ChangeEvent, type ReactNode } from 'react'

import { AppHeader } from '../../../components/app-header'
import { Advanced, Palette } from '../../../components/look-colours'
import {
  Fonts,
  PREVIEW_FAMILY,
  type FontActions,
} from '../../../components/look-fonts'
import { HostName } from '../../../components/host-name'
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
import { Input, Label } from '../../../components/ui/input'
import { cn } from '../../../lib/utils'
import {
  contrastChecks,
  headerName,
  logoUrl,
  lookCss,
  NAME_MAX,
  RADIUS_MAX,
  ratioText,
  sameLook,
  type Look,
  type PresetName,
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
          <p className="font-mono text-xs break-words text-neutral-500">
            <HostName host={view.deployment} /> <span aria-hidden>/</span>{' '}
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

        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-8 lg:grid-cols-[minmax(0,1fr)_23rem]">
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
            <Fonts draft={draft} onChange={edit} actions={FONT_ACTIONS} />
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
              <span className="flex min-w-0 items-center gap-1 text-right font-mono text-xs text-error-300">
                <CircleAlert aria-hidden className="size-3.5 shrink-0" />
                {check.worst}
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
          Every text colour the screens use needs at least 4.5:1 on what it sits
          on, so everyone can read it. Each line shows its lowest pair. Save is
          off until they all pass.
        </Note>
      )}
    </section>
  )
}

/** The font rows' calls to the deployment, a refusal as its message. */
const FONT_ACTIONS: FontActions = {
  copyGoogleFont: async (family) => {
    const result = await fetchGoogleFont({ data: { family } })
    return isScreenFailure(result) ? result.error.message : result
  },
  uploadFont: async (form) => {
    const result = await uploadFont({ data: form })
    return isScreenFailure(result) ? result.error.message : result
  },
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
          <div className="flex h-10 items-center gap-2 rounded-lg border border-border bg-input px-3 text-sm text-neutral-400">
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
