import { useMemo, useState } from 'react'
import type { DocumentEditor } from '@dossier/contracts'
import { FolderTree, Home } from 'lucide-react'

import { KindTag } from './document-list'
import { StatusMessage } from './status-message'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Modal } from './ui/modal'
import { useDocumentAction } from './use-document-action'
import type { MoveDestination } from '../server/documents'
import { cn } from '@/lib/utils'

const REFUSALS: Readonly<Record<string, string>> = {
  depth_exceeded:
    'That destination would push this subtree past 16 levels deep. Pick a shallower one.',
  cycle:
    'A document cannot be filed under itself, or under anything already beneath it.',
  parent_not_found:
    'That destination is gone, archived, disabled, or not one you can read. Reload and pick another.',
  conflict:
    'The document changed while the move was running. Reload the page and retry.',
  editor_required:
    'Only the author or a workspace admin can move this document.',
  publisher_required:
    'Moving needs a membership in this workspace. Ask an admin to add you back.',
}

export function MoveDialog({
  document,
  destinations,
  csrfToken,
  disabled,
  onMoved,
}: {
  document: DocumentEditor
  destinations: readonly MoveDestination[]
  csrfToken: string
  disabled?: boolean
  onMoved: (message: string) => void
}) {
  const { pending, failure, run } = useDocumentAction(csrfToken)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string>('root')

  const atRoot = document.parentId === null
  const filterActive = filter.trim().length > 0
  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (needle.length === 0) return destinations
    return destinations.filter(
      (destination) =>
        destination.title.toLowerCase().includes(needle) ||
        (destination.kind ?? '').includes(needle) ||
        destination.authorName.toLowerCase().includes(needle) ||
        destination.path.toLowerCase().includes(needle),
    )
  }, [destinations, filter])

  function start() {
    setSelected(document.parentId ?? 'root')
    setFilter('')
    setOpen(true)
  }

  async function move() {
    const target = destinations.find(
      (destination) => destination.id === selected,
    )
    const result = await run('move', {
      id: document.id,
      action: 'move',
      parentId: selected,
    })
    if (result === null) return
    setOpen(false)
    onMoved(
      selected === 'root'
        ? 'Moved to the workspace root.'
        : `Moved under “${target?.title ?? selected}”.`,
    )
  }

  const unchanged = selected === (document.parentId ?? 'root')

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={start}
        disabled={disabled}
        className="w-full"
      >
        <FolderTree aria-hidden />
        Move
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Move document"
        description={
          <>
            Everything filed under “{document.title}” moves with it. Authorship
            never changes; readers can change, because the new parent supplies
            the boundary whenever this document inherits one.
          </>
        }
        footer={
          <>
            {unchanged ? (
              <span className="text-xs text-neutral-500 sm:mr-auto sm:self-center">
                Already filed here
              </span>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending !== null}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={move}
              disabled={pending !== null || unchanged}
            >
              {pending === 'move' ? 'Moving…' : 'Move here'}
            </Button>
          </>
        }
      >
        {destinations.length > 8 ? (
          <Input
            aria-label="Filter destinations"
            placeholder="Filter by title, path, kind, or author"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="mb-3"
          />
        ) : null}

        <div role="group" aria-label="Destination" className="grid gap-1.5">
          <DestinationOption
            checked={selected === 'root'}
            onSelect={() => setSelected('root')}
            current={atRoot}
            depth={0}
          >
            <Home aria-hidden className="size-3.5 shrink-0 text-neutral-500" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-neutral-100">
                Workspace root
              </span>
              <span className="text-micro-lg block truncate text-neutral-500">
                Top level
              </span>
            </span>
          </DestinationOption>

          {matches.map((destination) => (
            <DestinationOption
              key={destination.id}
              checked={selected === destination.id}
              onSelect={() => setSelected(destination.id)}
              current={destination.current}
              depth={filterActive ? 0 : destination.depth}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-neutral-100">
                  {destination.title}
                </span>
                <span
                  className="text-micro-lg block truncate text-neutral-500"
                  title={destination.path}
                >
                  {destination.path}
                </span>
              </span>
              <KindTag kind={destination.kind} />
              <span className="text-micro-lg hidden max-w-28 shrink-0 truncate text-neutral-400 sm:inline">
                {destination.authorName}
              </span>
            </DestinationOption>
          ))}

          {matches.length === 0 ? (
            <p className="px-1 py-3 text-sm text-neutral-500">
              Nothing matches. Clear the filter, or move it to the root.
            </p>
          ) : null}
        </div>

        {failure ? (
          <StatusMessage tone="error" className="mt-3">
            {REFUSALS[failure.code] ?? failure.message}{' '}
            <span className="text-micro-lg text-neutral-500">
              {failure.code}
            </span>
          </StatusMessage>
        ) : null}
      </Modal>
    </>
  )
}

function DestinationOption({
  checked,
  onSelect,
  current,
  depth,
  children,
}: {
  checked: boolean
  onSelect: () => void
  current: boolean
  depth: number
  children: React.ReactNode
}) {
  return (
    <label
      style={{ marginLeft: `calc(0.75rem * ${Math.min(depth, 6)})` }}
      className={cn(
        'flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2',
        'transition-[border-color,background-color] duration-200 ease-agent',
        'has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
        checked
          ? 'border-brand-300/45 bg-brand-300/10'
          : 'border-border bg-neutral-900/60 hover:border-brand-300/30',
      )}
    >
      <input
        type="radio"
        name="destination"
        className="sr-only"
        checked={checked}
        onChange={onSelect}
      />
      {children}
      {current ? (
        <Badge variant="muted" className="shrink-0">
          current
        </Badge>
      ) : null}
    </label>
  )
}
