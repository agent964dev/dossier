import { dossierError, linkFor, parseTarget } from '@dossier/contracts'
import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'

import {
  Access,
  Config,
  CurrentCaller,
  Data,
  Files,
  Pages,
  People,
  type Entry,
  type SeenByRow,
} from '../core/index.ts'
import { kitNames } from './kit-row.ts'
import { runScreen, type ScreenFailure } from './run.ts'

export type { SeenByRow } from '../core/index.ts'

interface PushStamp {
  readonly number: number
  /** ISO 8601. */
  readonly at: string
}

/** What a folder's listing shows; every action is one the viewer may take. */
export interface ListingView {
  readonly deployment: string
  readonly me: { readonly email: string; readonly name: string }
  readonly crumbs: readonly { readonly name: string; readonly href: string }[]
  readonly folder: {
    readonly name: string
    readonly path: string
    readonly link: string
  }
  /** "Private to you", "Shared with sara@acme.com and 2 others". */
  readonly sharing: string
  /** Write holders' actions; more arrive with their features. */
  readonly can: { readonly seenBy: boolean; readonly kit: boolean }
  readonly pages: readonly {
    readonly title: string
    /** As the folder names it: 'plan.html', 'questions/'. */
    readonly path: string
    readonly link: string
    readonly push: PushStamp | null
    /** Pages with forms, for people who read their answers. */
    readonly responses: { readonly count: number; readonly link: string } | null
  }[]
  readonly folders: readonly {
    readonly name: string
    readonly link: string
    readonly pages: number
    readonly push: PushStamp | null
  }[]
  readonly files: readonly {
    readonly name: string
    readonly link: string
    /** Always a download. */
    readonly download: string
    /** 'PDF', 'PNG'. */
    readonly type: string
    readonly size: number
    readonly push: PushStamp | null
  }[]
  /**
   * Write holders only: the `_` files and folders the tree makes available
   * at this folder, closest first. Null when there are none.
   */
  readonly kit: { readonly names: readonly string[] } | null
  /** Only when the folder holds nothing; the hint is for write holders. */
  readonly empty: {
    readonly text: 'Nothing here yet.'
    readonly hint: string | null
  } | null
}

const stamp = (push: Entry['push']): PushStamp | null =>
  push === null
    ? null
    : { number: push.number, at: new Date(push.at).toISOString() }

/** A file's kind as a listing names it: its extension, upper-cased. */
const typeOf = (entry: Entry): string => {
  const dot = entry.name.lastIndexOf('.')
  if (dot > 0 && dot < entry.name.length - 1) {
    return entry.name.slice(dot + 1).toUpperCase()
  }
  const subtype = entry.contentType?.split(';')[0]?.split('/')[1]
  return subtype === undefined || subtype === 'octet-stream'
    ? 'File'
    : subtype.toUpperCase()
}

/** One line on who else a folder is shared with. */
const sharingLine = (
  shares: readonly { readonly targetKind: string; readonly target: string }[],
  me: string,
): string => {
  if (shares.some((s) => s.targetKind === 'anyone')) return 'Public'
  if (shares.some((s) => s.targetKind === 'workspace')) {
    return 'Shared with the workspace'
  }
  const others = [
    ...new Set(
      shares
        .filter((s) => s.targetKind !== 'team' && s.target !== me)
        .map((s) => s.target),
    ),
  ]
  const teams = shares.filter((s) => s.targetKind === 'team').length
  const count = others.length + teams
  if (count === 0) return 'Private to you'
  const first = others[0] ?? 'a team'
  if (count === 1) return `Shared with ${first}`
  return `Shared with ${first} and ${count - 1} ${count === 2 ? 'other' : 'others'}`
}

const notFound = () =>
  dossierError('not_found', 'Nothing is here, or you cannot open it.')

export const listingView = createServerFn({ method: 'GET' })
  .validator(
    (input: {
      readonly workspace: string
      readonly tree: string
      readonly path: string
    }) => ({
      workspace: String(input.workspace),
      tree: String(input.tree),
      path: String(input.path ?? '').replace(/^\/+|\/+$/g, ''),
    }),
  )
  .handler(({ data }): Promise<ListingView | ScreenFailure> =>
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
          `${data.workspace}/${data.tree}/${data.path === '' ? '' : `${data.path}/`}`,
          config.origin,
        )
        if (ref === null) return yield* Effect.fail(notFound())
        const listing = yield* (yield* Files).ls({ ref, depth: 'one' })
        if (listing.folder.kind !== 'folder') {
          return yield* Effect.fail(notFound())
        }
        const writer = listing.roles.caps.has('write')
        const kit = writer
          ? kitNames((yield* (yield* Files).kit(ref)).items)
          : []
        const shares = yield* (yield* People).sharedWith(listing.folder)
        const at = (path: string, kind: 'page' | 'folder' | 'file') =>
          linkFor(config.origin, {
            workspace: ref.workspace,
            tree: ref.tree,
            path,
            kind,
          })
        const entries = listing.entries
        const granted = yield* (yield* Access).require('read', listing.folder)
        const forms = yield* (yield* Data).pageForms(granted)
        const pages = entries
          .filter((e) => e.kind === 'page')
          .map((e) => {
            const folder = e.node.kind === 'folder'
            const link = folder ? at(e.path, 'folder') : at(e.path, 'page')
            const answered = forms.get(e.node.id)?.people ?? null
            return {
              title: e.title ?? e.name,
              path: folder ? `${e.name}/` : e.name,
              link,
              push: stamp(e.push),
              responses:
                answered === null
                  ? null
                  : {
                      count: answered,
                      link: `/_/responses${new URL(link).pathname}`,
                    },
            }
          })
        const folders = entries
          .filter((e) => e.kind === 'folder')
          .map((e) => ({
            name: e.name,
            link: at(e.path, 'folder'),
            pages: e.pages ?? 0,
            push: stamp(e.push),
          }))
        const files = entries
          .filter((e) => e.kind === 'attachment')
          .map((e) => ({
            name: e.name,
            link: at(e.path, 'file'),
            download: `/_/api/file?path=${encodeURIComponent(`${ref.workspace}/${ref.tree}/${e.path}`)}`,
            type: typeOf(e),
            size: e.size ?? 0,
            push: stamp(e.push),
          }))
        const segments = ref.path === '' ? [] : ref.path.split('/')
        const crumbs = [
          {
            name: ref.workspace,
            href: `/?w=${encodeURIComponent(ref.workspace)}`,
          },
          { name: ref.tree, href: at('', 'folder') },
          ...segments.slice(0, -1).map((name, index) => ({
            name,
            href: at(segments.slice(0, index + 1).join('/'), 'folder'),
          })),
        ]
        const nothing =
          pages.length === 0 && folders.length === 0 && files.length === 0
        const folderPath = ref.path === '' ? '' : `${ref.path}/`
        return {
          deployment: config.deploymentName,
          me: { email: me.email, name: me.name },
          crumbs,
          folder: {
            name: segments[segments.length - 1] ?? ref.tree,
            path: ref.path,
            link: at(ref.path, 'folder'),
          },
          sharing: sharingLine(shares, me.email.toLowerCase()),
          can: { seenBy: writer, kit: writer },
          pages,
          folders,
          files,
          kit: kit.length === 0 ? null : { names: kit },
          empty: nothing
            ? {
                text: 'Nothing here yet.',
                hint: writer
                  ? `dossier push <folder> ${ref.workspace}/${ref.tree}/${folderPath}`
                  : null,
              }
            : null,
        } satisfies ListingView
      }),
    ),
  )

export const seenBy = createServerFn({ method: 'GET' })
  .validator((input: { readonly link: string }) => ({
    link: String(input.link),
  }))
  .handler(({ data }): Promise<readonly SeenByRow[] | ScreenFailure> =>
    runScreen(
      Effect.gen(function* () {
        const config = yield* Config
        const ref = parseTarget(data.link, config.origin)
        if (ref === null) return yield* Effect.fail(notFound())
        return yield* (yield* Pages).seenBy(ref)
      }),
    ),
  )
