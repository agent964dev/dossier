import { dossierError, linkFor, parseTarget } from '@dossier/contracts'
import { Effect } from 'effect'

import {
  Access,
  Bindings,
  Config,
  CurrentCaller,
  Data,
  Files,
  Shares,
  type Entry,
  mentionedOnPage,
  unseenMentions,
} from '../core/index.ts'
import { kitNames } from './kit-row.ts'

interface PushStamp {
  readonly number: number
  /** ISO 8601. */
  readonly at: string
}

/** What a folder's listing shows; every action is one the viewer may take. */
export interface ListingView {
  readonly deployment: string
  /** Null for a visitor listing a public folder. */
  readonly me: { readonly email: string; readonly name: string } | null
  readonly crumbs: readonly { readonly name: string; readonly href: string }[]
  readonly folder: {
    readonly name: string
    readonly path: string
    readonly link: string
  }
  /** "Private to you", "Shared with sara@acme.com and 2 others". */
  readonly sharing: string
  /** Write holders' actions; more arrive with their features. */
  readonly can: {
    readonly seenBy: boolean
    readonly kit: boolean
    readonly share: boolean
  }
  readonly pages: readonly {
    readonly title: string
    /** As the folder names it: 'plan.html', 'questions/'. */
    readonly path: string
    readonly link: string
    readonly push: PushStamp | null
    /** Pages with forms, for people who read their answers. */
    readonly responses: { readonly count: number; readonly link: string } | null
    /** A mention of the viewer waits unseen on the page. */
    readonly mentioned: boolean
    /** The page as one file that works offline; null for a visitor. */
    readonly download: string | null
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

const notFound = () =>
  dossierError('not_found', 'Nothing is here, or you cannot open it.')

/** The listing screen's read model, as its server function runs it. */
export const listingModel = (data: {
  readonly workspace: string
  readonly tree: string
  readonly path: string
}) =>
  Effect.gen(function* () {
    const caller = yield* CurrentCaller
    const config = yield* Config
    // A visitor lists what anyone may read; Files refuses the rest.
    const me = caller.person
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
    const kit = writer ? kitNames((yield* (yield* Files).kit(ref)).items) : []
    const sharing = yield* (yield* Shares).sharingLabel(listing.folder)
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
    // A visitor has no mentions.
    const mentions =
      me === null ? [] : yield* unseenMentions((yield* Bindings).DB, me)
    const pages = entries
      .filter((e) => e.kind === 'page')
      .map((e) => {
        const folder = e.node.kind === 'folder'
        const link = folder ? at(e.path, 'folder') : at(e.path, 'page')
        const answered = forms.get(e.node.id)?.people ?? null
        const page = folder ? `${e.node.path}/index.html` : e.node.path
        return {
          download:
            me === null
              ? null
              : `/_/api/export?link=${encodeURIComponent(link)}`,
          mentioned: mentionedOnPage(mentions, e.node.treeId, page),
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
      // A visitor has no workspace home to go to.
      ...(me === null
        ? []
        : [
            {
              name: ref.workspace,
              href: `/?w=${encodeURIComponent(ref.workspace)}`,
            },
          ]),
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
      me: me === null ? null : { email: me.email, name: me.name },
      crumbs,
      folder: {
        name: segments[segments.length - 1] ?? ref.tree,
        path: ref.path,
        link: at(ref.path, 'folder'),
      },
      sharing,
      can: { seenBy: writer, kit: writer, share: writer },
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
  })
