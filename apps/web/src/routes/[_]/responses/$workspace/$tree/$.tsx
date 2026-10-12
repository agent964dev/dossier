import { createFileRoute, redirect } from '@tanstack/react-router'
import {
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  History,
} from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'

import { AppHeader } from '../../../../../components/app-header'
import { LocalTime } from '../../../../../components/local-time'
import { NoAccessScreen } from '../../../../../components/no-access'
import { Button } from '../../../../../components/ui/button'
import { Modal } from '../../../../../components/ui/modal'
import { isScreenFailure } from '../../../../../server/failure'
import { noAccessView } from '../../../../../server/no-access'
import {
  responsesView,
  revisionsView,
  type Cell,
  type ResponsesView,
  type RevisionView,
} from '../../../../../server/responses'

type Loaded =
  | { readonly kind: 'responses'; readonly view: ResponsesView }
  | { readonly kind: 'no-access'; readonly email: string | null }
  | { readonly kind: 'refused'; readonly message: string }

export const Route = createFileRoute('/_/responses/$workspace/$tree/$')({
  loader: async ({ params, location }): Promise<Loaded> => {
    const view = await responsesView({
      data: {
        workspace: params.workspace,
        tree: params.tree,
        path: params._splat ?? '',
      },
    })
    if (!isScreenFailure(view)) return { kind: 'responses', view }
    if (view.error.code === 'sign_in_required') {
      throw redirect({
        href: `/_/sign-in?next=${encodeURIComponent(location.href)}`,
      })
    }
    if (view.error.code === 'forbidden') {
      return { kind: 'refused', message: view.error.message }
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
          loaderData?.kind === 'responses'
            ? `Responses · ${loaderData.view.page.title} · ${loaderData.view.deployment}`
            : 'Dossier',
      },
    ],
  }),
  component: ResponsesRoute,
})

function ResponsesRoute() {
  const loaded = Route.useLoaderData()
  const params = Route.useParams()
  if (loaded.kind === 'no-access') {
    return <NoAccessScreen email={loaded.email} />
  }
  if (loaded.kind === 'refused') {
    return (
      <div className="min-h-dvh">
        <AppHeader email={null} />
        <main className="mx-auto flex max-w-xl flex-col gap-3 px-4 pt-10 text-center">
          <p className="font-clash text-xl font-semibold text-neutral-50">
            {loaded.message}
          </p>
        </main>
      </div>
    )
  }
  return (
    <Responses
      view={loaded.view}
      at={{
        workspace: params.workspace,
        tree: params.tree,
        page: params._splat ?? '',
      }}
    />
  )
}

interface PageAt {
  readonly workspace: string
  readonly tree: string
  readonly page: string
}

interface Sheet {
  readonly who: string
  readonly path: string
  readonly revisions: number
}

const LABEL =
  'font-mono text-[0.6875rem] tracking-[0.2em] text-neutral-500 uppercase'

function Responses({ view, at }: { view: ResponsesView; at: PageAt }) {
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const title = view.forms.length === 1 ? view.forms[0] : undefined
  return (
    <div className="min-h-dvh">
      <AppHeader email={view.me.email} />
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 pt-6 pb-16 sm:px-6">
        <div className="flex flex-col gap-3">
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
          <div className="flex flex-wrap items-center justify-between gap-3 md:flex-col md:items-start">
            <h1 className="font-clash text-[2rem] leading-tight font-semibold tracking-[-0.03em] break-words text-neutral-50 md:text-[2.5rem]">
              Responses
              <span className="max-md:sr-only">
                {' to '}
                <bdi>{view.page.title}</bdi>
              </span>
            </h1>
            <div className="flex items-center gap-2">
              <Button
                asChild
                variant="outline"
                size="lg"
                className="max-md:hidden"
              >
                <a href={view.page.link}>
                  <ExternalLink aria-hidden />
                  Open the page
                </a>
              </Button>
              <CopyForAgent markdown={view.markdown} />
            </div>
          </div>
          {title === undefined ? null : (
            <p className="flex items-center gap-2 text-[0.9375rem] text-neutral-300 md:hidden">
              <FileText aria-hidden className="size-4 text-neutral-500" />
              <span>
                <bdi>{title.title}</bdi> · {title.people}
              </span>
            </p>
          )}
        </div>

        {view.forms.length === 0 ? (
          <Empty text="No responses yet." />
        ) : (
          view.forms.map((form) => (
            <FormSection
              key={form.key}
              form={form}
              single={view.forms.length === 1}
              onRevisions={setSheet}
            />
          ))
        )}
      </main>
      <RevisionsSheet sheet={sheet} at={at} onClose={() => setSheet(null)} />
    </div>
  )
}

type FormView = ResponsesView['forms'][number]

function FormSection({
  form,
  single,
  onRevisions,
}: {
  form: FormView
  single: boolean
  onRevisions: (sheet: Sheet) => void
}) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <h2
          id={id}
          className={
            single
              ? 'sr-only'
              : 'font-clash text-[1.25rem] font-semibold tracking-[-0.02em] text-neutral-50'
          }
        >
          <bdi>{form.title}</bdi> · {form.people}
        </h2>
        <p className="hidden items-center gap-2 text-[0.9375rem] text-neutral-300 md:flex">
          <FileText aria-hidden className="size-4 text-neutral-500" />
          {form.summary}
        </p>
        <p className={`flex items-center gap-3 md:hidden ${LABEL}`}>
          <span>Form · {form.target}</span>
          <span aria-hidden className="h-px flex-1 bg-border" />
        </p>
      </div>
      {form.empty !== null ? (
        <Empty text={form.empty} />
      ) : form.shared !== null ? (
        <SharedValues values={form.shared} />
      ) : (
        <>
          <PersonCards form={form} onRevisions={onRevisions} />
          <ResponsesTable form={form} onRevisions={onRevisions} />
        </>
      )}
    </section>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <p className="rounded-xl border border-border bg-card px-5 py-8 text-center font-clash text-[1.125rem] font-semibold tracking-[-0.02em] text-neutral-50">
      {text}
    </p>
  )
}

function CellValue({ cell }: { cell: Cell }) {
  if ('text' in cell) {
    return cell.text === '' ? (
      <span className="text-neutral-600">—</span>
    ) : (
      <>{cell.text}</>
    )
  }
  return (
    <a
      href={cell.download}
      download
      className="rounded-sm text-brand-100 underline decoration-brand-300/40 underline-offset-4 outline-none hover:decoration-brand-300 focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {cell.file}
    </a>
  )
}

function Values({
  items,
}: {
  items: readonly {
    readonly field: string
    readonly label: string
    readonly cell: Cell
  }[]
}) {
  return (
    <dl className="grid grid-cols-[minmax(4.5rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {items.map((item) => (
        <div key={item.field} className="contents">
          <dt className="text-xs leading-5 text-neutral-400">{item.label}</dt>
          <dd className="min-w-0 break-words text-neutral-100">
            <CellValue cell={item.cell} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

const revisionsLabel = (n: number) =>
  n === 1 ? '1 revision' : `${n} revisions`

/** Phones: one card per person. */
function PersonCards({
  form,
  onRevisions,
}: {
  form: FormView
  onRevisions: (sheet: Sheet) => void
}) {
  return (
    <ul className="divide-y divide-border/80 rounded-xl border border-border bg-card md:hidden">
      {form.rows.map((row) => (
        <li key={row.path} className="flex flex-col gap-3 px-3.5 py-3.5">
          <div className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2.5">
              <span
                aria-hidden
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-neutral-700 text-xs font-semibold uppercase text-neutral-100"
              >
                {row.who.charAt(0)}
              </span>
              <span className="truncate text-[0.9375rem] text-neutral-50">
                {row.who}
              </span>
            </span>
            <span className="shrink-0 font-mono text-xs text-neutral-400">
              <LocalTime at={row.at} format="when" />
            </span>
          </div>
          <Values
            items={row.cells.map((cell, place) => ({
              ...cell,
              label: form.columns[place]?.label ?? cell.field,
            }))}
          />
          <div className={`flex items-center justify-between ${LABEL}`}>
            <span>On push {row.push}</span>
            {row.revisions > 1 ? (
              <button
                type="button"
                onClick={() =>
                  onRevisions({
                    who: row.who,
                    path: row.path,
                    revisions: row.revisions,
                  })
                }
                className="inline-flex items-center gap-1 rounded-sm text-brand-200 uppercase outline-none hover:text-brand-100 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {revisionsLabel(row.revisions)}
                <ChevronRight aria-hidden className="size-3.5" />
              </button>
            ) : (
              <span>{revisionsLabel(row.revisions)}</span>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Wider screens: each field of the form a column, each person a row. */
function ResponsesTable({
  form,
  onRevisions,
}: {
  form: FormView
  onRevisions: (sheet: Sheet) => void
}) {
  const head = `px-3.5 py-3 text-left font-normal ${LABEL}`
  return (
    <div className="hidden overflow-x-auto rounded-xl border border-border bg-card md:block">
      <table className="w-full border-collapse text-[0.9375rem]">
        <thead className="border-b border-border/80">
          <tr>
            <th scope="col" className={head}>
              Person
            </th>
            {form.columns.map((column) => (
              <th key={column.field} scope="col" className={head}>
                {column.label}
              </th>
            ))}
            <th scope="col" className={head}>
              Sent
            </th>
            <th scope="col" className={head}>
              Revisions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/80">
          {form.rows.map((row) => (
            <tr key={row.path} className="align-top">
              <th
                scope="row"
                className="px-3.5 py-3.5 text-left font-normal whitespace-nowrap text-neutral-50"
              >
                {row.who}
              </th>
              {row.cells.map((cell) => (
                <td
                  key={cell.field}
                  className="px-3.5 py-3.5 break-words text-neutral-100"
                >
                  <CellValue cell={cell.cell} />
                </td>
              ))}
              <td className="px-3.5 py-3.5 font-mono text-xs whitespace-nowrap text-neutral-400">
                <LocalTime at={row.at} format="when" /> · push {row.push}
              </td>
              <td className="px-3.5 py-3">
                {row.revisions > 1 ? (
                  <button
                    type="button"
                    onClick={() =>
                      onRevisions({
                        who: row.who,
                        path: row.path,
                        revisions: row.revisions,
                      })
                    }
                    className="text-micro-lg inline-flex items-center gap-1.5 rounded-md border border-brand-300/30 bg-brand-300/10 px-2 py-[3px] font-medium whitespace-nowrap text-brand-200 outline-none hover:bg-brand-300/15 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    {revisionsLabel(row.revisions)}
                  </button>
                ) : (
                  <span className="font-mono text-xs text-neutral-400">
                    {row.revisions}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A shared file: each field's value, and who changed it last. */
function SharedValues({ values }: { values: NonNullable<FormView['shared']> }) {
  return (
    <ul className="divide-y divide-border/80 rounded-xl border border-border bg-card">
      {values.map((value) => (
        <li
          key={value.label}
          className="flex flex-col gap-1 px-4 py-3 md:flex-row md:items-baseline md:justify-between md:gap-4"
        >
          <span className="min-w-0 text-[0.9375rem]">
            <span className="text-neutral-400">{value.label}: </span>
            <span className="break-words text-neutral-50">
              {value.text === '' ? '—' : value.text}
            </span>
          </span>
          <span className="shrink-0 font-mono text-xs text-neutral-400">
            changed by {value.by}, <LocalTime at={value.at} format="day" />
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Copies the responses as Markdown under the form's labels. */
function CopyForAgent({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown)
      setCopied(true)
    } catch {
      // Without the Clipboard API, the text is selected for a manual copy.
      const area = document.createElement('textarea')
      area.value = markdown
      document.body.appendChild(area)
      area.select()
      const done = document.execCommand('copy')
      area.remove()
      setCopied(done)
    }
  }
  return (
    <Button size="lg" onClick={() => void copy()}>
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      <span aria-live="polite">{copied ? 'Copied' : 'Copy for agent'}</span>
    </Button>
  )
}

function RevisionsSheet({
  sheet,
  at,
  onClose,
}: {
  sheet: Sheet | null
  at: PageAt
  onClose: () => void
}) {
  return (
    <Modal
      open={sheet !== null}
      onClose={onClose}
      title={sheet?.who ?? ''}
      description={
        sheet === null ? undefined : (
          <span className="inline-flex items-center gap-1.5">
            <History aria-hidden className="size-3.5" />
            {revisionsLabel(sheet.revisions)}, newest first
          </span>
        )
      }
      footer={
        <p className="text-center text-xs text-neutral-400 sm:w-full">
          Every revision is kept, with the push it was sent on.
        </p>
      }
    >
      {sheet === null ? null : (
        <RevisionList key={sheet.path} at={at} path={sheet.path} />
      )}
    </Modal>
  )
}

function RevisionList({ at, path }: { at: PageAt; path: string }) {
  const [list, setList] = useState<
    readonly RevisionView[] | 'loading' | 'failed'
  >('loading')
  useEffect(() => {
    let live = true
    revisionsView({
      data: { workspace: at.workspace, tree: at.tree, page: at.page, path },
    }).then(
      (value) => {
        if (live) setList(isScreenFailure(value) ? 'failed' : value)
      },
      () => {
        if (live) setList('failed')
      },
    )
    return () => {
      live = false
    }
  }, [at.workspace, at.tree, at.page, path])
  if (list === 'loading') {
    return <p className="text-sm text-neutral-400">Loading…</p>
  }
  if (list === 'failed') {
    return (
      <p className="text-sm text-neutral-300">
        Something went wrong. Try again.
      </p>
    )
  }
  return (
    <ol className="divide-y divide-border/80 rounded-xl border border-border">
      {list.map((revision) => (
        <li
          key={revision.revision}
          className="flex flex-col gap-3 px-3.5 py-3.5"
        >
          <RevisionHead>
            <span className="text-[0.9375rem] text-neutral-50">
              Revision {revision.revision}
            </span>
            <span className="font-mono text-xs text-neutral-400">
              <LocalTime at={revision.at} format="when" /> · push{' '}
              {revision.push}
            </span>
          </RevisionHead>
          <Values items={revision.cells} />
        </li>
      ))}
    </ol>
  )
}

function RevisionHead({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      {children}
    </div>
  )
}
