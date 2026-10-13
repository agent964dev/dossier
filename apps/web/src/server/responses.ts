import { dossierError, linkFor, parseTarget } from '@dossier/contracts'
import type { Json } from '@dossier/contracts/bridge'
import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import {
  Config,
  CurrentCaller,
  Data,
  type FormResponses,
  type ResponseRow,
} from '../core/index.ts'
import { runScreen, type ScreenFailure } from './run.ts'

/** A cell: text, an upload that downloads, or a JSON field's object. */
export type Cell =
  | { readonly text: string }
  | { readonly file: string; readonly download: string }
  | {
      /** '3 keys', shown while the value is folded. */
      readonly summary: string
      /** The object, indented. */
      readonly json: string
    }

/** What the responses screen shows, per form of the page. */
export interface ResponsesView {
  readonly deployment: string
  readonly me: { readonly email: string }
  readonly crumbs: readonly { readonly name: string; readonly href: string }[]
  readonly page: { readonly title: string; readonly link: string }
  readonly forms: readonly {
    /** The form's identity: its page or layout, target and id. */
    readonly key: string
    /** 'Delivery questions', shown before how many answered. */
    readonly title: string
    /** '3 people'. */
    readonly people: string
    /** 'answers/', as the form names it from the page's folder. */
    readonly target: string
    /** 'The form writes answers/.' */
    readonly summary: string
    /** The form's labels, its current fields only. */
    readonly columns: readonly {
      readonly field: string
      readonly label: string
    }[]
    readonly rows: readonly {
      readonly who: string
      /** When it was sent, ms since the epoch; screens show the viewer's time. */
      readonly at: number
      readonly push: number
      readonly revisions: number
      readonly cells: readonly { readonly field: string; readonly cell: Cell }[]
      /** The data file's link on this deployment, for its revisions. */
      readonly path: string
    }[]
    /** A shared file's values, each with who changed it last. */
    readonly shared:
      | readonly {
          readonly label: string
          readonly text: string
          readonly cell: Cell
          readonly by: string
          /** When it was last changed, ms since the epoch. */
          readonly at: number
        }[]
      | null
    readonly empty: 'No responses yet.' | null
  }[]
  /** What Copy for agent copies. */
  readonly markdown: string
}

export interface RevisionView {
  readonly revision: number
  /** ms since the epoch. */
  readonly at: number
  readonly push: number
  readonly by: string
  readonly cells: readonly {
    readonly field: string
    readonly label: string
    readonly cell: Cell
  }[]
}

const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
})
const DAY_YEAR = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
})

const folderOf = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

const isUpload = (value: unknown): value is { file: string; name: string } =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { file?: unknown }).file === 'string' &&
  typeof (value as { name?: unknown }).name === 'string'

const isObject = (value: unknown): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** A value as people read it: lists joined, dates as '3 Nov'. */
const textOf = (value: Json | undefined, type: string): string => {
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) {
    return value.map((item) => textOf(item, type)).join(', ')
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    if (type === 'date' && DATE.test(value)) {
      const date = new Date(`${value}T00:00:00Z`)
      return Number.isNaN(date.getTime()) ? value : DAY.format(date)
    }
    return value
  }
  return JSON.stringify(value)
}

export const dataViews = (i: {
  readonly workspace: string
  readonly tree: string
}) => {
  const download = (path: string) =>
    `/_/api/file?path=${encodeURIComponent(`${i.workspace}/${i.tree}/${path}`)}`

  /** One value of a row, an upload linking to its download. */
  const cellOf = (value: Json | undefined, type: string, own: string): Cell => {
    const uploads = (Array.isArray(value) ? value : [value]).filter(isUpload)
    if (uploads.length > 0 && type === 'file') {
      const first = uploads[0]!
      return {
        file: uploads.map((u) => u.name).join(', '),
        download: download(`${own}/${first.file}`),
      }
    }
    if (type === 'json' && isObject(value)) {
      const keys = Object.keys(value).length
      return {
        summary: keys === 1 ? '1 key' : `${keys} keys`,
        json: JSON.stringify(value, null, 2),
      }
    }
    return { text: textOf(value, type) }
  }

  /** The folder a row's uploads sit in. */
  const ownOf = (form: FormResponses['form'], row: ResponseRow) =>
    form.kind === 'entries'
      ? folderOf(row.path)
      : `${folderOf(row.path)}/${row.email}`

  /** The folder a shared file's upload sits in: its writer's, beside the file. */
  const sharedOwnOf = (form: FormResponses['form'], by: string) =>
    `${form.target.replace(/\.json$/i, '')}.files/${by.toLowerCase()}`

  return { cellOf, ownOf, sharedOwnOf }
}

/** A cell as one line of text, a JSON field's object compact. */
const cellText = (cell: Cell) =>
  'text' in cell
    ? cell.text
    : 'file' in cell
      ? cell.file
      : JSON.stringify(JSON.parse(cell.json))

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

const notFound = () =>
  dossierError('not_found', 'Nothing is here, or you cannot open it.')

export const responsesView = createServerFn({ method: 'GET' })
  .validator(
    (input: {
      readonly workspace: string
      readonly tree: string
      readonly path: string
    }) => ({
      workspace: String(input.workspace),
      tree: String(input.tree),
      path: String(input.path ?? ''),
    }),
  )
  .handler(({ data }): Promise<ResponsesView | ScreenFailure> =>
    runScreen(
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const config = yield* Config
        const me = caller.person
        if (me === null) {
          return yield* Effect.fail(
            dossierError('sign_in_required', 'Sign in to open this.'),
          )
        }
        const ref = parseTarget(
          `${data.workspace}/${data.tree}/${data.path}`,
          config.origin,
        )
        if (ref === null) return yield* Effect.fail(notFound())
        const found = yield* (yield* Data).responses(ref)
        const { cellOf, ownOf, sharedOwnOf } = dataViews(ref)
        const at = (path: string, kind: 'page' | 'folder' | 'file') =>
          linkFor(config.origin, {
            workspace: ref.workspace,
            tree: ref.tree,
            path,
            kind,
          })
        const pageLink = `${config.origin.origin}/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(ref.tree)}/${found.page.link}`
        const pageFolder = folderOf(found.page.path)
        const fromPage = (target: string) =>
          pageFolder !== '' && target.startsWith(`${pageFolder}/`)
            ? target.slice(pageFolder.length + 1)
            : target
        const segments = folderOf(found.page.path)
          .split('/')
          .filter((s) => s !== '')
        const pageName = found.page.path.endsWith('/index.html')
          ? (segments[segments.length - 1] ?? ref.tree)
          : found.page.path
              .slice(found.page.path.lastIndexOf('/') + 1)
              .replace(/\.html$/, '')
        const crumbs = [
          {
            name: ref.workspace,
            href: `/?w=${encodeURIComponent(ref.workspace)}`,
          },
          { name: ref.tree, href: at('', 'folder') },
          ...(found.page.path.endsWith('/index.html')
            ? segments.slice(0, -1)
            : segments
          ).map((name, index) => ({
            name,
            href: at(segments.slice(0, index + 1).join('/'), 'folder'),
          })),
          { name: pageName, href: pageLink },
        ]
        const md: string[] = [
          `# Responses to ${found.page.title}`,
          '',
          pageLink,
        ]
        const forms = found.forms.map((f) => {
          // An untitled form is named by its id, or by the page it is on.
          const title = f.form.title ?? f.form.id ?? found.page.title
          const target = fromPage(f.form.target)
          const people = plural(f.people, 'person', 'people')
          const fields = f.form.fields
          const rows = f.rows.map((row) => {
            const own = ownOf(f.form, row)
            return {
              who: row.email,
              at: row.at,
              push: row.push,
              revisions: row.revisions,
              cells: fields.map((field) => ({
                field: field.name,
                cell: cellOf(row.values[field.name], field.type, own),
              })),
              path: row.path,
            }
          })
          const shared =
            f.shared === null
              ? null
              : fields.flatMap((field) => {
                  const value = f.shared?.find((s) => s.field === field.name)
                  if (value === undefined) return []
                  const cell = cellOf(
                    value.value,
                    field.type,
                    sharedOwnOf(f.form, value.by),
                  )
                  return [
                    {
                      label: field.label,
                      text: cellText(cell),
                      cell,
                      by: value.by,
                      at: value.at,
                    },
                  ]
                })
          const empty =
            rows.length === 0 && (shared === null || shared.length === 0)
          md.push('', `## ${title} · ${people}`, `Form · ${target}`)
          if (empty) md.push('', 'No responses yet.')
          for (const [index, row] of rows.entries()) {
            const sent = DAY_YEAR.format(new Date(f.rows[index]?.at ?? 0))
            md.push(
              '',
              `### ${row.who}`,
              `Sent ${sent.replace(' at ', ', ')} UTC · push ${row.push} · ${plural(row.revisions, 'revision', 'revisions')}`,
              ...fields.map(
                (field, place) =>
                  `- ${field.label}: ${cellText(row.cells[place]?.cell ?? { text: '' })}`,
              ),
            )
          }
          for (const value of shared ?? []) {
            md.push(
              `- ${value.label}: ${value.text} (changed by ${value.by}, ${DAY.format(new Date(value.at))})`,
            )
          }
          return {
            title,
            people,
            target,
            summary: `${plural(f.people, 'person', 'people')} answered. The form writes ${target}.`,
            key: `${f.form.host}|${f.form.target}|${f.form.id ?? ''}`,
            columns: fields.map((field) => ({
              field: field.name,
              label: field.label,
            })),
            rows,
            shared,
            empty: empty ? ('No responses yet.' as const) : null,
          }
        })
        return {
          deployment: config.deploymentName,
          me: { email: me.email },
          crumbs,
          page: { title: found.page.title, link: pageLink },
          forms,
          markdown: `${md.join('\n')}\n`,
        } satisfies ResponsesView
      }),
    ),
  )

export const revisionsView = createServerFn({ method: 'GET' })
  .validator(
    (input: {
      readonly workspace: string
      readonly tree: string
      readonly page: string
      readonly path: string
    }) => ({
      workspace: String(input.workspace),
      tree: String(input.tree),
      page: String(input.page ?? ''),
      path: String(input.path),
    }),
  )
  .handler(({ data }): Promise<readonly RevisionView[] | ScreenFailure> =>
    runScreen(
      Effect.gen(function* () {
        const config = yield* Config
        const ref = parseTarget(
          `${data.workspace}/${data.tree}/${data.page}`,
          config.origin,
        )
        if (ref === null) return yield* Effect.fail(notFound())
        const store = yield* Data
        const found = yield* store.responses(ref)
        const form = found.forms.find((f) =>
          f.rows.some((row) => row.path === data.path),
        )
        const row = form?.rows.find((r) => r.path === data.path)
        if (form === undefined || row === undefined) {
          return yield* Effect.fail(notFound())
        }
        const { cellOf, ownOf } = dataViews(ref)
        const own = ownOf(form.form, row)
        const revisions = yield* store.revisions({ ref, path: data.path })
        return revisions.map((revision): RevisionView => ({
          revision: revision.revision,
          at: revision.at,
          push: revision.push,
          by: revision.by,
          cells: form.form.fields.map((field) => ({
            field: field.name,
            label: field.label,
            cell: cellOf(revision.values[field.name], field.type, own),
          })),
        }))
      }),
    ),
  )
