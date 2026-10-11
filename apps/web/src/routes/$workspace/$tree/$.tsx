import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import {
  File,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  Lock,
  Users,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { AppHeader } from '../../../components/app-header'
import { NoAccessScreen } from '../../../components/no-access'
import { MenuButton, MenuLink, RowMenu } from '../../../components/row-menu'
import { SectionLabel } from '../../../components/section-label'
import { Modal } from '../../../components/ui/modal'
import { isScreenFailure } from '../../../server/failure'
import {
  listingView,
  seenBy,
  type ListingView,
  type SeenByRow,
} from '../../../server/listing'
import { noAccessView } from '../../../server/no-access'

type Loaded =
  | { readonly kind: 'listing'; readonly view: ListingView }
  | { readonly kind: 'no-access'; readonly email: string | null }

export const Route = createFileRoute('/$workspace/$tree/$')({
  loader: async ({ params, location }): Promise<Loaded> => {
    const view = await listingView({
      data: {
        workspace: params.workspace,
        tree: params.tree,
        path: params._splat ?? '',
      },
    })
    if (!isScreenFailure(view)) return { kind: 'listing', view }
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
          loaderData?.kind === 'listing'
            ? `${loaderData.view.folder.name} · ${loaderData.view.deployment}`
            : 'Dossier',
      },
    ],
  }),
  component: ListingRoute,
})

function ListingRoute() {
  const loaded = Route.useLoaderData()
  return loaded.kind === 'no-access' ? (
    <NoAccessScreen email={loaded.email} />
  ) : (
    <Listing view={loaded.view} />
  )
}

const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
})

/** "push 12 · 10 Oct". */
const pushLabel = (push: { number: number; at: string } | null) =>
  push === null
    ? null
    : `push ${push.number} · ${DAY.format(new Date(push.at))}`

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
function Meta({ first, second }: { first: ReactNode; second: string | null }) {
  return (
    <span className={META}>
      <span className="md:truncate">{first}</span>
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

function ColumnHeads({
  name,
  first,
  second,
}: {
  name: string
  first: string
  second: string
}) {
  return (
    <div
      aria-hidden
      className="hidden items-center gap-3 border-b border-border/80 px-3.5 py-2 md:flex"
    >
      <span className="size-8 shrink-0" />
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)] gap-4 font-mono text-[0.6875rem] tracking-[0.2em] text-neutral-500 uppercase">
        <span>{name}</span>
        <span>{first}</span>
        <span>{second}</span>
      </div>
      <span className="size-8 shrink-0" />
    </div>
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

function Listing({ view }: { view: ListingView }) {
  const [seen, setSeen] = useState<{ title: string; link: string } | null>(null)
  return (
    <div className="min-h-dvh">
      <AppHeader email={view.me.email} />
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
          <h1 className="font-clash text-[2rem] leading-tight font-semibold tracking-[-0.03em] break-words text-neutral-50">
            {view.folder.name}
          </h1>
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
                  <ColumnHeads name="Title" first="Path" second="Last push" />
                }
              >
                {view.pages.map((page) => (
                  <li key={page.link} className={ROW}>
                    <RowIcon>
                      <FileText />
                    </RowIcon>
                    <div className={COLUMNS}>
                      {/* A page opens in the shell: a whole new document. */}
                      <a href={page.link} className={NAME_LINK}>
                        {page.title}
                      </a>
                      <Meta first={page.path} second={pushLabel(page.push)} />
                    </div>
                    <RowMenu label={`More for ${page.title}`}>
                      <MenuLink href={page.link}>Open</MenuLink>
                      {view.can.seenBy ? (
                        <MenuButton
                          onSelect={() =>
                            setSeen({ title: page.title, link: page.link })
                          }
                        >
                          Seen by
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
                        to={new URL(folder.link).pathname}
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
                    </RowMenu>
                  </li>
                ))}
              </Section>
            )}
          </>
        )}
      </main>
      <SeenBySheet page={seen} onClose={() => setSeen(null)} />
    </div>
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
  const [rows, setRows] = useState<readonly SeenByRow[] | 'loading' | 'failed'>(
    'loading',
  )
  useEffect(() => {
    let live = true
    seenBy({ data: { link } }).then(
      (value) => {
        if (live) setRows(isScreenFailure(value) ? 'failed' : value)
      },
      () => {
        if (live) setRows('failed')
      },
    )
    return () => {
      live = false
    }
  }, [link])
  if (rows === 'loading') {
    return <p className="text-sm text-neutral-400">Loading…</p>
  }
  if (rows === 'failed') {
    return (
      <p className="text-sm text-neutral-300">
        Something went wrong. Try again.
      </p>
    )
  }
  if (rows.length === 0) {
    return (
      <p className="text-sm text-neutral-300">
        Nobody has opened this page yet.
      </p>
    )
  }
  return (
    <ul className="divide-y divide-border/80">
      {rows.map((row) => (
        <li
          key={row.email}
          className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2.5"
        >
          <span className="min-w-0 font-mono text-sm break-all text-neutral-50">
            {row.email}
          </span>
          <span className="text-xs text-neutral-400">
            {row.withinHour
              ? 'last opened within the hour'
              : DAY.format(new Date(row.lastSeenAt))}
          </span>
        </li>
      ))}
    </ul>
  )
}
