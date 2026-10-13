import { Link, useRouter } from '@tanstack/react-router'
import {
  File,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  History,
  Lock,
  UserPlus,
  Users,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { isScreenFailure } from '../server/failure'
import { seenBy, type ListingView, type SeenBy } from '../server/listing'
import { AppHeader } from './app-header'
import { DeleteDialog, type Deleting } from './delete-dialog'
import { LocalTime } from './local-time'
import { MentionedBadge } from './mentioned-badge'
import { MenuButton, MenuLink, RowMenu } from './row-menu'
import { SectionLabel } from './section-label'
import { ShareDialog } from './share-dialog'
import { Button } from './ui/button'
import { Modal } from './ui/modal'

/** "push 12 · 10 Oct", the day on the viewer's clock. */
const pushLabel = (push: { number: number; at: string } | null) =>
  push === null ? null : (
    <>
      push {push.number} · <LocalTime at={push.at} format="day" />
    </>
  )

/** "2.1 MB". */
export const sizeLabel = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

const ROW =
  'flex min-h-14 items-center gap-3 px-3.5 py-2.5 transition-colors duration-200 ease-agent hover:bg-neutral-800/35'
/** On wider screens the row's parts line up in columns. */
const COLUMNS =
  'min-w-0 flex-1 md:grid md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-center md:gap-4'
const META = 'block truncate font-mono text-xs text-neutral-400 md:contents'
const NAME_LINK =
  'block truncate rounded-sm text-[0.9375rem] text-neutral-50 outline-none hover:text-brand-100 focus-visible:ring-[3px] focus-visible:ring-ring/50'

function RowIcon({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-neutral-800/70 text-neutral-300 [&_svg]:size-4"
    >
      {children}
    </span>
  )
}

/** The two meta parts: one line on phones, two columns on wider screens. */
function Meta({ first, second }: { first: ReactNode; second: ReactNode }) {
  return (
    <span className={META}>
      <span className="md:truncate">
        <bdi>{first}</bdi>
      </span>
      {second === null ? null : (
        <>
          <span aria-hidden className="md:hidden">
            {' · '}
          </span>
          <span className="md:truncate">{second}</span>
        </>
      )}
    </span>
  )
}

/** Pages with a response column, when any page here collects answers. */
const PAGE_COLUMNS =
  'min-w-0 flex-1 md:grid md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1fr)] md:items-center md:gap-4'

function ColumnHeads({
  name,
  first,
  middle,
  second,
}: {
  name: string
  first: string
  middle?: string
  second: string
}) {
  return (
    <div
      aria-hidden
      className="hidden items-center gap-3 border-b border-border/80 px-3.5 py-2 md:flex"
    >
      <span className="size-8 shrink-0" />
      <div
        className={`grid min-w-0 flex-1 gap-4 font-mono text-[0.6875rem] tracking-[0.2em] text-neutral-500 uppercase ${
          middle === undefined
            ? 'grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]'
            : 'grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,1fr)]'
        }`}
      >
        <span>{name}</span>
        <span>{first}</span>
        {middle === undefined ? null : <span>{middle}</span>}
        <span>{second}</span>
      </div>
      <span className="size-8 shrink-0" />
    </div>
  )
}

/** "3 responses": opens the page's responses. */
function ResponsesBadge({
  responses,
}: {
  responses: { count: number; link: string }
}) {
  return (
    <a
      href={responses.link}
      className="inline-flex w-fit items-center gap-1.5 rounded-md border border-brand-300/30 bg-brand-300/10 px-2 py-0.5 text-xs whitespace-nowrap text-brand-100 outline-none hover:bg-brand-300/15 focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-brand-300" />
      {responses.count === 1 ? '1 response' : `${responses.count} responses`}
    </a>
  )
}

function Section({
  id,
  label,
  count,
  heads,
  children,
}: {
  id: string
  label: string
  count: number
  heads?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <SectionLabel id={id} count={count}>
        {label}
      </SectionLabel>
      <div className="rounded-xl border border-border bg-card">
        {heads}
        <ul className="divide-y divide-border/80">{children}</ul>
      </div>
    </section>
  )
}

function SharingLine({ text }: { text: string }) {
  const icon =
    text === 'Private to you' ? (
      <Lock />
    ) : text === 'Public' ? (
      <Globe />
    ) : (
      <Users />
    )
  return (
    <p className="flex items-center gap-2 text-[0.9375rem] text-neutral-300 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-neutral-500">
      <span aria-hidden className="contents">
        {icon}
      </span>
      {text}
    </p>
  )
}

/**
 * A folder's listing: at its link when it has no `index.html`, and in the
 * Files screen (`label` "Files") whether it has one or not.
 */
export function ListingScreen({
  view,
  label,
}: {
  view: ListingView
  /** A mono micro-label after the name in the header, such as "Files". */
  label?: string
}) {
  const router = useRouter()
  const [seen, setSeen] = useState<{ title: string; link: string } | null>(null)
  const [sharing, setSharing] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Deleting | null>(null)
  const answered = view.pages.some((page) => page.responses !== null)
  return (
    <div className="min-h-dvh">
      <AppHeader email={view.me?.email ?? null} label={label} />
      <main className="mx-auto flex max-w-4xl flex-col gap-6 px-4 pt-6 pb-16 sm:px-6">
        <div className="flex flex-col gap-2">
          <nav aria-label="Breadcrumbs">
            <ol className="flex flex-wrap items-center gap-x-1.5 font-mono text-xs text-neutral-400">
              {view.crumbs.map((crumb, index) => (
                <li key={crumb.href} className="flex items-center gap-1.5">
                  {index === 0 ? null : (
                    <span aria-hidden className="text-neutral-600">
                      /
                    </span>
                  )}
                  <a
                    href={crumb.href}
                    className="rounded-sm break-all outline-none hover:text-neutral-100 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    {crumb.name}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
          {/* The actions go below a name too long to sit beside them. */}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <h1 className="min-w-0 font-clash text-[2rem] leading-tight font-semibold tracking-[-0.03em] break-words text-neutral-50">
              {view.folder.name}
            </h1>
            <div className="flex shrink-0 items-center gap-2">
              {view.can.history && view.history !== null ? (
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="sm:h-10 sm:px-4 sm:text-sm"
                >
                  <a href={view.history}>
                    <History aria-hidden />
                    History
                  </a>
                </Button>
              ) : null}
              {view.can.share ? (
                <Button
                  size="sm"
                  className="sm:h-10 sm:px-4 sm:text-sm"
                  aria-haspopup="dialog"
                  onClick={() => setSharing(view.folder.link)}
                >
                  <UserPlus aria-hidden />
                  Share
                </Button>
              ) : null}
            </div>
          </div>
          <SharingLine text={view.sharing} />
        </div>

        {view.empty !== null ? (
          <EmptyState empty={view.empty} />
        ) : (
          <>
            {view.pages.length === 0 ? null : (
              <Section
                id="pages-label"
                label="Pages"
                count={view.pages.length}
                heads={
                  <ColumnHeads
                    name="Title"
                    first="Path"
                    {...(answered ? { middle: 'Responses' } : {})}
                    second="Last push"
                  />
                }
              >
                {view.pages.map((page) => (
                  <li key={page.link} className={ROW}>
                    <RowIcon>
                      <FileText />
                    </RowIcon>
                    <div className={answered ? PAGE_COLUMNS : COLUMNS}>
                      {/* A page opens in the shell: a whole new document. */}
                      {page.mentioned ? (
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          <a
                            href={page.link}
                            className={`${NAME_LINK} min-w-0`}
                          >
                            <bdi>{page.title}</bdi>
                          </a>
                          <MentionedBadge />
                        </span>
                      ) : (
                        <a href={page.link} className={NAME_LINK}>
                          <bdi>{page.title}</bdi>
                        </a>
                      )}
                      {answered ? (
                        <>
                          <span className={META}>
                            <span className="md:truncate">
                              <bdi>{page.path}</bdi>
                            </span>
                            {page.push === null ? null : (
                              <span aria-hidden className="md:hidden">
                                {' · '}
                              </span>
                            )}
                            <span className="md:hidden">
                              {pushLabel(page.push)}
                            </span>
                          </span>
                          {page.responses === null ? (
                            <span aria-hidden className="hidden md:block" />
                          ) : (
                            <span className="mt-1.5 block md:mt-0">
                              <ResponsesBadge responses={page.responses} />
                            </span>
                          )}
                          <span className="hidden truncate font-mono text-xs text-neutral-400 md:block">
                            {pushLabel(page.push)}
                          </span>
                        </>
                      ) : (
                        <Meta first={page.path} second={pushLabel(page.push)} />
                      )}
                    </div>
                    <RowMenu label={`More for ${page.title}`}>
                      <MenuLink href={page.link}>Open</MenuLink>
                      {page.files === null ? null : (
                        <MenuLink href={page.files}>Files</MenuLink>
                      )}
                      {page.download === null ? null : (
                        <MenuLink href={page.download} download>
                          Download as one file
                        </MenuLink>
                      )}
                      {page.responses === null ? null : (
                        <MenuLink href={page.responses.link}>
                          Responses
                        </MenuLink>
                      )}
                      {view.can.share ? (
                        <MenuButton onSelect={() => setSharing(page.link)}>
                          Share
                        </MenuButton>
                      ) : null}
                      {view.can.seenBy ? (
                        <MenuButton
                          onSelect={() =>
                            setSeen({ title: page.title, link: page.link })
                          }
                        >
                          Seen by
                        </MenuButton>
                      ) : null}
                      {view.can.delete ? (
                        <MenuButton
                          destructive
                          onSelect={() =>
                            setDeleting({
                              name: page.path,
                              target: page.target,
                            })
                          }
                        >
                          Delete
                        </MenuButton>
                      ) : null}
                    </RowMenu>
                  </li>
                ))}
              </Section>
            )}
            {view.folders.length === 0 ? null : (
              <Section
                id="folders-label"
                label="Folders"
                count={view.folders.length}
                heads={
                  <ColumnHeads name="Name" first="Pages" second="Last push" />
                }
              >
                {view.folders.map((folder) => (
                  <li key={folder.link} className={ROW}>
                    <RowIcon>
                      <Folder />
                    </RowIcon>
                    <div className={COLUMNS}>
                      <Link
                        to={folder.files ?? new URL(folder.link).pathname}
                        className={`${NAME_LINK} font-mono`}
                      >
                        {folder.name}/
                      </Link>
                      <Meta
                        first={
                          folder.pages === 1
                            ? '1 page'
                            : `${folder.pages} pages`
                        }
                        second={pushLabel(folder.push)}
                      />
                    </div>
                    <RowMenu label={`More for ${folder.name}/`}>
                      <MenuLink href={folder.link}>Open</MenuLink>
                      {view.can.share ? (
                        <MenuButton onSelect={() => setSharing(folder.link)}>
                          Share
                        </MenuButton>
                      ) : null}
                      {view.can.delete ? (
                        <MenuButton
                          destructive
                          onSelect={() =>
                            setDeleting({
                              name: `${folder.name}/`,
                              target: folder.target,
                            })
                          }
                        >
                          Delete
                        </MenuButton>
                      ) : null}
                    </RowMenu>
                  </li>
                ))}
              </Section>
            )}
            {view.files.length === 0 ? null : (
              <Section
                id="files-label"
                label="Files"
                count={view.files.length}
                heads={
                  <ColumnHeads name="Name" first="Kind" second="Last push" />
                }
              >
                {view.files.map((file) => (
                  <li key={file.link} className={ROW}>
                    <RowIcon>
                      <File />
                    </RowIcon>
                    <div className={COLUMNS}>
                      <a href={file.link} className={`${NAME_LINK} font-mono`}>
                        {file.name}
                      </a>
                      <Meta
                        first={`${file.type}, ${sizeLabel(file.size)}`}
                        second={pushLabel(file.push)}
                      />
                    </div>
                    <RowMenu label={`More for ${file.name}`}>
                      <MenuLink href={file.link}>Open</MenuLink>
                      <MenuLink href={file.download} download>
                        Download
                      </MenuLink>
                      {view.can.delete ? (
                        <MenuButton
                          destructive
                          onSelect={() =>
                            setDeleting({
                              name: file.name,
                              target: file.target,
                            })
                          }
                        >
                          Delete
                        </MenuButton>
                      ) : null}
                    </RowMenu>
                  </li>
                ))}
              </Section>
            )}
          </>
        )}
        {view.kit === null ? null : <KitRow names={view.kit.names} />}
      </main>
      <SeenBySheet page={seen} onClose={() => setSeen(null)} />
      <ShareDialog
        link={sharing}
        onClose={() => setSharing(null)}
        onChanged={() => void router.invalidate()}
      />
      <DeleteDialog
        deleting={deleting}
        retentionDays={view.retentionDays}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null)
          void router.invalidate()
        }}
      />
    </div>
  )
}

/** The `_` files pages here inherit; only write holders ever see them. */
function KitRow({ names }: { names: readonly string[] }) {
  return (
    <section
      aria-labelledby="kit-label"
      className="flex flex-col gap-2.5 rounded-xl border border-dashed border-neutral-500/45 px-4 py-3.5"
    >
      <div className="flex items-center justify-between gap-3 text-xs text-neutral-400">
        <h2
          id="kit-label"
          className="rounded-md border border-neutral-400/30 bg-neutral-400/12 px-2 py-1 font-mono text-[0.6875rem] leading-none tracking-[0.16em] text-neutral-400 uppercase"
        >
          Kit
        </h2>
        <span className="inline-flex items-center gap-1.5 [&_svg]:size-3.5">
          <Lock aria-hidden />
          Write holders only
        </span>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {names.map((name) => (
          <li key={name}>
            <code className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.75rem] text-neutral-300">
              {name}
            </code>
          </li>
        ))}
      </ul>
    </section>
  )
}

function EmptyState({ empty }: { empty: NonNullable<ListingView['empty']> }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-5 py-8 text-center">
      <FolderOpen aria-hidden className="size-6 text-neutral-400" />
      <p className="font-clash text-[1.125rem] font-semibold tracking-[-0.02em] text-neutral-50">
        {empty.text}
      </p>
      {empty.hint === null ? null : (
        <p className="max-w-sm text-sm leading-relaxed text-neutral-300">
          Publish with{' '}
          <code className="rounded-md border border-brand-300/20 bg-brand-300/10 px-1.5 py-0.5 font-mono text-[0.8125rem] break-words text-brand-100 [box-decoration-break:clone]">
            {empty.hint}
          </code>
          .
        </p>
      )}
    </div>
  )
}

function SeenBySheet({
  page,
  onClose,
}: {
  page: { title: string; link: string } | null
  onClose: () => void
}) {
  return (
    <Modal
      open={page !== null}
      onClose={onClose}
      title="Seen by"
      description={page?.title}
    >
      {page === null ? null : <SeenByList key={page.link} link={page.link} />}
    </Modal>
  )
}

/** Who opened a page; loaded when the sheet opens for it. */
function SeenByList({ link }: { link: string }) {
  const [seen, setSeen] = useState<SeenBy | 'loading' | 'failed'>('loading')
  useEffect(() => {
    let live = true
    seenBy({ data: { link } }).then(
      (value) => {
        if (live) setSeen(isScreenFailure(value) ? 'failed' : value)
      },
      () => {
        if (live) setSeen('failed')
      },
    )
    return () => {
      live = false
    }
  }, [link])
  if (seen === 'loading') {
    return <p className="text-sm text-neutral-400">Loading…</p>
  }
  if (seen === 'failed') {
    return (
      <p className="text-sm text-neutral-300">
        Something went wrong. Try again.
      </p>
    )
  }
  const views =
    seen.views === null ? null : (
      <p className="font-mono text-xs text-neutral-300">
        {seen.views === 1
          ? '1 view in the last 30 days'
          : `${seen.views} views in the last 30 days`}
      </p>
    )
  if (seen.people.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {views}
        <p className="text-sm text-neutral-300">
          {seen.views === null
            ? 'Nobody has opened this page yet.'
            : 'Nobody signed in has opened this page yet.'}
        </p>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      {views}
      <ul className="divide-y divide-border/80">
        {seen.people.map((row) => (
          <li
            key={row.email}
            className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2.5"
          >
            <span className="min-w-0 font-mono text-sm break-all text-neutral-50">
              {row.email}
            </span>
            <span className="text-xs text-neutral-400">
              {row.withinHour ? (
                'last opened within the hour'
              ) : (
                <LocalTime at={row.lastSeenAt} format="day" />
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
