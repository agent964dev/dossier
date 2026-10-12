import { Building2, Globe, TriangleAlert, UserPlus, Users } from 'lucide-react'
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'

import { cn } from '@/lib/utils'
import { isScreenFailure, type ScreenFailure } from '../server/failure'
import {
  setShare,
  shareDialogView,
  type DialogShare,
  type Role,
  type ShareDialogView,
  type ShareTarget,
} from '../server/share-dialog'
import { SectionLabel } from './section-label'
import { Initial, Note } from './settings-parts'
import { Button } from './ui/button'
import { Select } from './ui/input'
import { Modal } from './ui/modal'

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly view: ShareDialogView }

const WRONG = 'Something went wrong. Try again.'

const messageOf = (failure: ScreenFailure): string =>
  failure.error.fix === null
    ? failure.error.message
    : `${failure.error.message} ${failure.error.fix}`

/**
 * Who can open a folder, page or file, and the one place to change it: a
 * sheet on phones, a dialog on wider screens. Every change is saved at once
 * and the dialog shows what the server answers.
 */
export function ShareDialog({
  link,
  onClose,
  onChanged,
}: {
  /** The node's link; null keeps the dialog closed. */
  link: string | null
  onClose: () => void
  /** After a change went through, so the screen behind can refresh. */
  onChanged?: () => void
}) {
  /** What was loaded, and for which link. */
  const [loaded, setLoaded] = useState<{
    readonly link: string
    readonly load: Load
  } | null>(null)
  const load: Load =
    loaded !== null && loaded.link === link ? loaded.load : { kind: 'loading' }

  useEffect(() => {
    if (link === null) return
    let live = true
    const settle = (next: Load) => {
      if (live) setLoaded({ link, load: next })
    }
    shareDialogView({ data: { link } }).then(
      (value) =>
        settle(
          isScreenFailure(value)
            ? { kind: 'failed', message: messageOf(value) }
            : { kind: 'ready', view: value },
        ),
      () => settle({ kind: 'failed', message: WRONG }),
    )
    return () => {
      live = false
    }
  }, [link])

  const close = () => {
    setLoaded(null)
    onClose()
  }

  return (
    <Modal
      open={link !== null}
      onClose={close}
      handle
      title={load.kind === 'ready' ? load.view.title : 'Share'}
    >
      {link === null ? null : load.kind === 'loading' ? (
        <p className="text-sm text-neutral-400">Loading…</p>
      ) : load.kind === 'failed' ? (
        <p role="alert" className="text-sm text-error-300">
          {load.message}
        </p>
      ) : (
        <ShareBody
          key={link}
          link={link}
          view={load.view}
          onView={(view) => {
            setLoaded({ link, load: { kind: 'ready', view } })
            onChanged?.()
          }}
        />
      )}
    </Modal>
  )
}

/** What a select offers; '' is no access. */
type Choice = Role | ''

const PEOPLE_ROLES: readonly (readonly [Choice, string])[] = [
  ['read', 'Read'],
  ['respond', 'Respond'],
  ['write', 'Write'],
]
const NO_ACCESS: readonly [Choice, string] = ['', 'No access']
const ANYONE_ROLES: readonly (readonly [Choice, string])[] = [
  NO_ACCESS,
  ['read', 'Read'],
  ['respond', 'Read and respond'],
  ['write', 'Write'],
]

const ROLE_NAMES: Record<Role, string> = {
  read: 'Read',
  respond: 'Respond',
  write: 'Write',
}
const ANYONE_NAMES: Record<Role, string> = {
  ...ROLE_NAMES,
  respond: 'Read and respond',
}

/** "Read · from acme/": where an inherited share comes from. */
function FromLine({ role, from }: { role: string; from: string | null }) {
  return (
    <span className="font-mono text-xs break-words text-neutral-400">
      {role} · from {from}
    </span>
  )
}

const choiceOf = (role: Role | null): Choice => role ?? ''
const roleOf = (choice: string): Role | null =>
  choice === 'read' || choice === 'respond' || choice === 'write'
    ? choice
    : null

/** The text in the add field as a share target, or null when it is empty. */
const targetOf = (
  text: string,
  teams: ShareDialogView['teams'],
): Extract<ShareTarget, { kind: 'email' | 'team' }> | null => {
  const value = text.trim()
  if (value === '') return null
  const team = value.includes('@')
    ? undefined
    : teams.find((t) => t.name.toLowerCase() === value.toLowerCase())
  return team === undefined
    ? { kind: 'email', email: value }
    : { kind: 'team', team: team.name }
}

function ShareBody({
  link,
  view,
  onView,
}: {
  link: string
  view: ShareDialogView
  onView: (view: ShareDialogView) => void
}) {
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  /** The role a row shows while its change is on its way. */
  const [pending, setPending] = useState<{
    readonly key: string
    readonly role: Role | null
  } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const anyoneRef = useRef<HTMLSelectElement>(null)
  /** Set when the Anyone button turns sharing on: its select takes focus. */
  const focusAnyone = useRef(false)

  /** Sends one change; resolves to the refusal's message, or null. */
  const send = async (
    target: ShareTarget,
    role: Role | null,
    key: string,
  ): Promise<string | null> => {
    setBusy(true)
    setSaved(false)
    setPending({ key, role })
    try {
      const result = await setShare({ data: { link, target, role } })
      if (isScreenFailure(result)) return messageOf(result)
      onView(result)
      setSaved(true)
      return null
    } catch {
      return WRONG
    } finally {
      setBusy(false)
      setPending(null)
    }
  }

  const change = async (
    target: ShareTarget,
    role: Role | null,
    key: string,
  ) => {
    if (busy) return
    setRefused(null)
    setRefused(await send(target, role, key))
  }

  const shown = (key: string, role: Role | null): Choice =>
    choiceOf(pending?.key === key ? pending.role : role)

  // Shares from folders above are listed on their own, never edited here:
  // the rows below set only this node's own shares, whatever is inherited
  // (respond does not include read, and a data folder's own public share
  // is not the same as one above it).
  const inherited = view.inherited

  const workspace = shown('workspace', view.workspaceRole)
  const anyone: Choice = confirming ? 'write' : shown('anyone', view.anyoneRole)
  const name = view.title.replace(/^Share /, '')

  useEffect(() => {
    if (focusAnyone.current && anyone !== '') {
      focusAnyone.current = false
      anyoneRef.current?.focus()
    }
  })

  const chooseAnyone = (choice: string) => {
    if (busy) return
    const role = roleOf(choice)
    if (role === 'write' && anyone !== 'write') {
      setRefused(null)
      setConfirming(true)
      return
    }
    setConfirming(false)
    void change({ kind: 'anyone' }, role, 'anyone')
  }

  const settle = async (confirmed: boolean) => {
    if (busy) return
    if (confirmed) {
      setRefused(null)
      setRefused(await send({ kind: 'anyone' }, 'write', 'anyone'))
    }
    setConfirming(false)
    anyoneRef.current?.focus()
  }

  return (
    <div className="flex flex-col gap-4">
      <AddRow view={view} busy={busy} send={send} />

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <SectionLabel>Who can open it</SectionLabel>
          </div>
          <p role="status" className="shrink-0 text-xs text-neutral-400">
            {busy ? (
              'Saving…'
            ) : saved ? (
              <span className="sr-only">Saved.</span>
            ) : null}
          </p>
        </div>
        <ul
          aria-label="Who can open it"
          aria-busy={busy}
          className="divide-y transition-opacity duration-200 ease-agent aria-busy:opacity-70 divide-border/80 overflow-hidden rounded-xl border border-border bg-card"
        >
          {view.direct.map((share) => (
            <ShareRow
              key={share.key}
              icon={
                share.target.kind === 'email' ? (
                  <Initial of={share.label} />
                ) : (
                  <Tile>
                    <Users />
                  </Tile>
                )
              }
              name={share.label}
              control={
                <RoleSelect
                  label={`Role of ${share.label}`}
                  value={shown(share.key, share.role)}
                  options={[...PEOPLE_ROLES, NO_ACCESS]}
                  onChange={(choice) =>
                    void change(share.target, roleOf(choice), share.key)
                  }
                />
              }
            />
          ))}
          {inherited.map((share) => (
            <InheritedRow key={`from:${share.key}`} share={share} />
          ))}
          <ShareRow
            icon={
              <Tile>
                <Building2 />
              </Tile>
            }
            name={`Everyone in ${view.workspace}`}
            wrap
            control={
              <RoleSelect
                label={`Role of everyone in ${view.workspace}`}
                value={workspace}
                options={[NO_ACCESS, ...PEOPLE_ROLES]}
                onChange={(choice) =>
                  void change(
                    { kind: 'workspace' },
                    roleOf(choice),
                    'workspace',
                  )
                }
              />
            }
          />
          <ShareRow
            highlighted={anyone !== ''}
            wrap
            icon={
              <Tile on={anyone !== ''}>
                <Globe />
              </Tile>
            }
            name="Anyone with the link"
            onName={
              anyone === ''
                ? () => {
                    if (busy) return
                    focusAnyone.current = true
                    chooseAnyone('respond')
                  }
                : undefined
            }
            control={
              <RoleSelect
                ref={anyoneRef}
                label="Role of anyone with the link"
                value={anyone}
                options={ANYONE_ROLES}
                on={anyone !== ''}
                onChange={chooseAnyone}
              />
            }
          />
        </ul>
        {confirming ? (
          <Callout icon={<TriangleAlert />}>
            <p role="alert" className="font-semibold text-neutral-50">
              Anyone with a Google account will be able to publish pages here.
            </p>
            <div className="mt-2.5 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void settle(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="warn-solid"
                size="sm"
                aria-disabled={busy || undefined}
                onClick={() => void settle(true)}
              >
                Confirm
              </Button>
            </div>
          </Callout>
        ) : anyone === 'read' || anyone === 'respond' ? (
          <PublicReach kind={view.kind} reach={view.publicReach} />
        ) : null}
        {refused === null ? null : (
          <p role="alert" className="text-sm text-error-300">
            {refused}
          </p>
        )}
      </div>

      {view.kind === 'folder' ? (
        <Note>Everything inside {name} is included.</Note>
      ) : view.kind === 'page' ? (
        <Note>This page and the files it needs are included.</Note>
      ) : null}
    </div>
  )
}

/**
 * The field that adds a person by email or one of the workspace's teams,
 * suggesting the teams as the person types.
 */
function AddRow({
  view,
  busy,
  send,
}: {
  view: ShareDialogView
  busy: boolean
  send: (
    target: ShareTarget,
    role: Role | null,
    key: string,
  ) => Promise<string | null>
}) {
  const [text, setText] = useState('')
  const [role, setRole] = useState<Role>('read')
  const [failed, setFailed] = useState<string | null>(null)
  const [listOpen, setListOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const ids = useId()
  const inputId = `${ids}-add`
  const listId = `${ids}-teams`
  const errorId = `${ids}-error`

  const query = text.trim().toLowerCase()
  const suggestions =
    query === '' || query.includes('@')
      ? []
      : view.teams.filter(
          (team) =>
            team.name.toLowerCase().includes(query) &&
            team.name.toLowerCase() !== query,
        )
  const showList = listOpen && suggestions.length > 0
  const target = targetOf(text, view.teams)

  const pick = (name: string) => {
    setText(name)
    setListOpen(false)
    setActive(-1)
    setFailed(null)
    inputRef.current?.focus()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || target === null) return
    setFailed(null)
    const message = await send(target, role, 'add')
    if (message === null) {
      setText('')
      setRole('read')
    } else {
      setFailed(message)
    }
    inputRef.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!showList) {
      if (event.key === 'ArrowDown' && suggestions.length > 0) {
        event.preventDefault()
        setListOpen(true)
        setActive(0)
      }
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => (index + 1) % suggestions.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => (index <= 0 ? suggestions.length - 1 : index - 1))
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault()
      const team = suggestions[active]
      if (team !== undefined) pick(team.name)
    } else if (event.key === 'Escape') {
      // Closes the suggestions, not the dialog.
      event.preventDefault()
      setListOpen(false)
      setActive(-1)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <label htmlFor={inputId} className="sr-only">
        Add a person or a team
      </label>
      <div className="relative">
        <UserPlus
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          inputMode="email"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={
            showList && active >= 0 ? `${listId}-${active}` : undefined
          }
          aria-invalid={failed === null ? undefined : true}
          aria-describedby={failed === null ? undefined : errorId}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Add a person or a team"
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setListOpen(true)
            setActive(-1)
            setFailed(null)
          }}
          onBlur={() => setListOpen(false)}
          onKeyDown={onKeyDown}
          className={cn(
            'flex h-11 w-full min-w-0 rounded-lg border border-border bg-input py-2 pr-3 pl-10',
            'text-base text-neutral-100 md:text-sm',
            'placeholder:text-neutral-400',
            'transition-[color,border-color,box-shadow] duration-200 ease-agent',
            'outline-none focus-visible:border-brand-300/50 focus-visible:ring-[3px] focus-visible:ring-ring/40',
            target?.kind === 'team' && 'pr-16',
          )}
        />
        {target?.kind === 'team' ? (
          <span
            aria-hidden
            className="text-micro-lg pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded-md border border-brand-300/45 bg-brand-300/15 px-1.5 py-1 text-brand-200"
          >
            Team
          </span>
        ) : null}
      </div>
      <ul
        id={listId}
        role="listbox"
        aria-label="Teams"
        hidden={!showList}
        className="flex flex-col rounded-xl border border-border bg-card p-1"
      >
        {suggestions.map((team, index) => (
          <li
            key={team.id}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === active}
            // Keeps the field focused, so the pick lands in it.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => pick(team.name)}
            className={cn(
              'flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-neutral-200 transition-colors duration-200 ease-agent hover:bg-neutral-800/70',
              index === active && 'bg-neutral-800/70 text-brand-100',
            )}
          >
            <Users aria-hidden className="size-4 shrink-0 text-neutral-400" />
            Team {team.name}
          </li>
        ))}
      </ul>
      {failed === null ? null : (
        <p id={errorId} role="alert" className="text-sm text-error-300">
          {failed}
        </p>
      )}
      {target === null ? null : (
        <div className="flex items-center justify-end gap-2">
          <RoleSelect
            label={
              target.kind === 'team'
                ? `Role for Team ${target.team}`
                : `Role for ${target.email}`
            }
            value={role}
            options={PEOPLE_ROLES}
            onChange={(choice) => setRole(roleOf(choice) ?? 'read')}
          />
          <Button
            type="submit"
            aria-disabled={busy || undefined}
            className="h-9"
          >
            Add
          </Button>
        </div>
      )}
    </form>
  )
}

function Tile({ children, on = false }: { children: ReactNode; on?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-neutral-800/70 text-neutral-300 [&_svg]:size-4',
        on && 'bg-brand-300/10 text-brand-300',
      )}
    >
      {children}
    </span>
  )
}

function ShareRow({
  icon,
  name,
  detail,
  control,
  highlighted = false,
  wrap = false,
  onName,
}: {
  icon: ReactNode
  name: string
  detail?: ReactNode
  control: ReactNode
  highlighted?: boolean
  /** Lets a long name wrap rather than cut, for fixed names. */
  wrap?: boolean
  /** Makes the name a button that turns the share on. */
  onName?: () => void
}) {
  const nameClass = cn(
    'text-[0.9375rem] leading-snug text-neutral-50',
    wrap ? 'break-words' : 'truncate',
  )
  return (
    <li
      className={cn(
        'flex min-h-14 items-center gap-3 px-3.5 py-2.5 transition-colors duration-200 ease-agent',
        highlighted &&
          'bg-brand-300/6 shadow-[inset_2px_0_0_var(--color-brand-300)]',
      )}
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {onName === undefined ? (
          <span title={wrap ? undefined : name} className={nameClass}>
            {name}
          </span>
        ) : (
          <button
            type="button"
            aria-pressed={false}
            onClick={onName}
            className={cn(
              nameClass,
              '-mx-1.5 -my-1 w-fit cursor-pointer rounded-md px-1.5 py-1 text-left outline-none transition-colors duration-200 ease-agent hover:bg-neutral-800/70 hover:text-brand-100 focus-visible:ring-[3px] focus-visible:ring-ring/50',
            )}
          >
            {name}
          </button>
        )}
        {detail}
      </span>
      {control}
    </li>
  )
}

const TARGET_ICONS = {
  email: null,
  team: <Users />,
  workspace: <Building2 />,
  anyone: <Globe />,
} as const

/** A share on a folder above; it is changed there, not here. */
function InheritedRow({ share }: { share: DialogShare }) {
  const icon = TARGET_ICONS[share.target.kind]
  return (
    <ShareRow
      icon={
        icon === null ? (
          <Initial of={share.label} />
        ) : (
          <Tile on={share.target.kind === 'anyone'}>{icon}</Tile>
        )
      }
      name={share.label}
      detail={
        <FromLine
          role={
            (share.target.kind === 'anyone' ? ANYONE_NAMES : ROLE_NAMES)[
              share.role
            ]
          }
          from={share.from}
        />
      }
      control={null}
    />
  )
}

function RoleSelect({
  label,
  value,
  options,
  onChange,
  on = false,
  ref,
}: {
  label: string
  value: Choice
  options: readonly (readonly [Choice, string])[]
  onChange: (choice: string) => void
  /** The cyan look of a choice that opens the node widely. */
  on?: boolean
  ref?: Ref<HTMLSelectElement>
}) {
  return (
    <Select
      ref={ref}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      wrapperClassName="w-auto shrink-0"
      className={cn(
        'h-9 min-w-[6.5rem] py-0 pr-8 pl-2.5 text-sm',
        on && 'border-brand-300/55 bg-brand-300/8 text-brand-200',
      )}
    >
      {options.map(([choice, text]) => (
        <option key={choice} value={choice}>
          {text}
        </option>
      ))}
    </Select>
  )
}

/** A warning-toned note inside the dialog. */
function Callout({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-xl border border-warning-400/30 bg-warning-400/10 px-3.5 py-3 text-sm leading-relaxed text-neutral-100">
      <span aria-hidden className="mt-0.5 text-warning-300 [&_svg]:size-4">
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** Names the `_` files shown before the rest are cut to "…". */
const NAMED = 2

/** What becomes public with an Anyone share. */
function PublicReach({
  kind,
  reach,
}: {
  kind: ShareDialogView['kind']
  reach: readonly string[]
}) {
  const what =
    kind === 'folder'
      ? 'this folder'
      : kind === 'page'
        ? 'this page'
        : 'this file'
  const named = reach.slice(0, NAMED)
  const rest = reach.slice(NAMED)
  return (
    <Callout icon={<Globe />}>
      <p className="font-semibold text-neutral-50">Becomes public</p>
      <p>
        {reach.length === 0 ? (
          what
        ) : (
          <>
            {what} and {reach.length} shared{' '}
            {reach.length === 1 ? 'file' : 'files'} above it:{' '}
            {named.map((path, index) => (
              <span key={path}>
                {index === 0 ? null : ', '}
                <code className="font-mono text-[0.8125rem] break-words text-brand-100">
                  {path}
                </code>
              </span>
            ))}
            {rest.length === 0 ? null : (
              <>
                <span aria-hidden>, …</span>
                <span className="sr-only">, {rest.join(', ')}</span>
              </>
            )}
          </>
        )}
      </p>
    </Callout>
  )
}
