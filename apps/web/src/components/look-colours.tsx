import { ChevronDown, Settings2 } from 'lucide-react'
import { useId, useState } from 'react'

import { cn } from '@/lib/utils'
import {
  DEFAULT_ROLES,
  parseColor,
  roleColor,
  ROLES,
  scaleFrom,
  SCALES,
  STEPS,
  type Look,
  type RoleName,
  type RoleValue,
  type ScaleName,
  type Step,
  type StepName,
} from '../lib/look'
import { SectionLabel } from './section-label'
import { Button } from './ui/button'
import { Input, Label, Select } from './ui/input'

/**
 * The Look screen's colour editors: the palette's scales with an editor for
 * one step, and the role each colour role uses. Both edit a draft Look.
 */

const SCALE_TITLES: Readonly<Record<ScaleName, string>> = {
  neutral: 'Neutral',
  brand: 'Brand',
  accent: 'Accent',
  complement: 'Complement',
  success: 'Success',
  warning: 'Warning',
  error: 'Error',
}

export function Palette({
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
  // A preset or a fill replaces the step's colour while the editor is open:
  // show the new colour unless it is what this field just applied.
  const [shown, setShown] = useState(value)
  if (value !== shown) {
    setShown(value)
    if (value !== text.trim()) setText(value)
  }
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

export function Advanced({
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
  const own = value !== undefined && 'color' in value ? value.color : null
  const [text, setText] = useState(own ?? '')
  // A preset replaces the role's colour: the field follows it, and a role
  // back at its default forgets what was typed for it.
  const [shown, setShown] = useState(own)
  if (own !== shown) {
    setShown(own)
    if (own === null) setText('')
    else if (own !== text.trim()) setText(own)
  }
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
