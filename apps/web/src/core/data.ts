// People's data: form sends, uploads, withdrawals, data reads and the
// responses a page's forms collected. Every write goes through one
// TreeStore change with its operation ID, so a retry never stores twice.
import {
  dossierError,
  isNodeName,
  MAX_DEPTH,
  type AuthoredSeq,
  type DataReadResult,
  type DocWire,
  type DossierError,
  type FormRefSchema,
  type LinkRef,
  type NodeId,
  type OpId,
  type PushNumber,
  type SendResult,
  type Sha256,
  type TreeId,
  type UploadResult,
  type WritePayload,
} from '@dossier/contracts'
import type { Json, JsonObject } from '@dossier/contracts/bridge'
import {
  acceptsFile,
  validateSend,
  validateValues,
  type FieldEntry,
  type FieldType,
  type UploadValue,
} from '@dossier/html'
import { Clock, Context, Effect, Layer } from 'effect'

import { Access, type Granted } from './access.ts'
import type { Background } from './background.ts'
import { Bindings } from './bindings.ts'
import { CurrentCaller } from './caller.ts'
import { newId } from './ids.ts'
import { composedLayouts } from './lookup.ts'
import { Limits } from './limits.ts'
import type { NodeRow, TreeRow, VersionRow } from './rows.ts'
import {
  blobKey,
  TreeStore,
  type ChangeSet,
  type DocRow,
  type FormRow,
  type NodeHandle,
  type VersionHandle,
  DATA_FILE_TOO_LARGE,
} from './tree-store.ts'

type FormRef = typeof FormRefSchema.Type

export interface SendInput {
  readonly treeId: TreeId
  /** The page's tree path. */
  readonly page: string
  readonly seq: AuthoredSeq
  readonly form: FormRef
  readonly entries: readonly FieldEntry[]
  readonly submitter: { readonly name: string; readonly value: string } | null
  /** One of the caller's entries to revise, or null. */
  readonly entry: string | null
  readonly opId: OpId
  /** Whom the page was shown to; null or absent when it did not say. */
  readonly as?: string | null
}

export interface UploadInput {
  readonly treeId: TreeId
  readonly page: string
  readonly seq: AuthoredSeq
  readonly form: FormRef | null
  /** The file field's name. */
  readonly field: string | null
  readonly name: string
  readonly type: string
  readonly size: number
  readonly sha256: Sha256
  readonly body: ReadableStream<Uint8Array>
  readonly opId: OpId
  /** Whom the page was shown to; null or absent when it did not say. */
  readonly as?: string | null
}

export interface ResponseRow {
  /** The data file's tree path. */
  readonly path: string
  readonly email: string
  readonly name: string
  readonly at: number
  readonly push: PushNumber
  readonly revisions: number
  readonly values: JsonObject
}

export interface FormResponses {
  readonly form: {
    readonly host: string
    readonly target: string
    readonly id: string | null
    readonly kind: 'person' | 'entries' | 'shared'
    readonly title: string | null
    readonly fields: readonly {
      readonly name: string
      readonly label: string
      readonly type: FieldType
    }[]
  }
  readonly people: number
  /** Person forms: one per person · entries: one per entry · shared: none. */
  readonly rows: readonly ResponseRow[]
  /** Shared files: each field's value, and who changed it last. */
  readonly shared:
    | readonly {
        readonly field: string
        readonly value: Json
        readonly by: string
        readonly at: number
      }[]
    | null
}

export interface Responses {
  readonly page: {
    readonly path: string
    readonly title: string
    readonly link: string
  }
  readonly forms: readonly FormResponses[]
}

export interface Revision {
  readonly revision: number
  readonly at: number
  readonly push: PushNumber
  readonly by: string
  readonly values: JsonObject
}

/** What a listing shows of a page's forms: null people when not readable. */
export interface PageForms {
  readonly targets: readonly string[]
  readonly people: number | null
}

/** What a person's answers come to: the files they own. */
export interface MineCounts {
  readonly submissions: number
  readonly entries: number
  readonly uploads: number
}

export interface DataService {
  readonly send: (
    i: SendInput,
  ) => Effect.Effect<
    SendResult,
    DossierError<
      | 'invalid'
      | 'closed'
      | 'form_changed'
      | 'forbidden'
      | 'not_found'
      | 'sign_in_required'
      | 'too_large'
      | 'not_mergeable'
      | 'rate_limited'
      | 'unavailable'
    >,
    CurrentCaller | Background
  >
  readonly upload: (
    i: UploadInput,
  ) => Effect.Effect<
    UploadResult,
    DossierError<
      | 'invalid'
      | 'closed'
      | 'form_changed'
      | 'forbidden'
      | 'not_found'
      | 'sign_in_required'
      | 'too_large'
      | 'rate_limited'
      | 'blob_reclaiming'
      | 'unavailable'
    >,
    CurrentCaller | Background
  >
  readonly withdraw: (i: {
    readonly treeId: TreeId
    readonly path: string
    readonly opId: OpId
    readonly as?: string | null
  }) => Effect.Effect<
    void,
    DossierError<
      'not_found' | 'forbidden' | 'sign_in_required' | 'unavailable'
    >,
    CurrentCaller | Background
  >
  /**
   * Page code's write: an RFC 7396 merge into a data file the caller owns or
   * a shared one it may answer into, the whole value of its own file, or a
   * new entry in its own folder for a folder path.
   */
  readonly write: (
    i: WritePayload,
  ) => Effect.Effect<
    DocWire,
    DossierError<
      | 'forbidden'
      | 'invalid'
      | 'not_mergeable'
      | 'closed'
      | 'too_large'
      | 'rate_limited'
      | 'sign_in_required'
      | 'not_found'
      | 'unavailable'
    >,
    CurrentCaller | Background
  >
  /**
   * Never not_found: missing and unreadable read as nothing. Authored files
   * too; too_large for a folder past the caps.
   */
  readonly read: (i: {
    readonly treeId: TreeId
    readonly path: string
  }) => Effect.Effect<
    DataReadResult,
    DossierError<'too_large' | 'unavailable'>,
    CurrentCaller
  >
  /**
   * The forms of the pages in a folder, by the listing entry's node (the
   * folder for a folder page): their targets, and how many people answered.
   */
  readonly pageForms: (
    folder: Granted<'read'>,
  ) => Effect.Effect<
    ReadonlyMap<NodeId, PageForms>,
    DossierError<'unavailable'>,
    CurrentCaller
  >
  /**
   * Withdraws every data file the person owns on the deployment, and the
   * folders of theirs left empty, with a withdrawal event per file.
   */
  readonly withdrawMine: () => Effect.Effect<
    MineCounts & { readonly trees: number },
    DossierError<'sign_in_required' | 'unavailable'>,
    CurrentCaller | Background
  >
  readonly mineCounts: () => Effect.Effect<
    MineCounts,
    DossierError<'sign_in_required' | 'unavailable'>,
    CurrentCaller
  >
  readonly responses: (
    ref: LinkRef,
  ) => Effect.Effect<
    Responses,
    DossierError<
      'not_found' | 'sign_in_required' | 'forbidden' | 'unavailable'
    >,
    CurrentCaller
  >
  readonly revisions: (i: {
    readonly ref: LinkRef
    readonly path: string
  }) => Effect.Effect<
    readonly Revision[],
    DossierError<
      'not_found' | 'sign_in_required' | 'forbidden' | 'unavailable'
    >,
    CurrentCaller
  >
}

export class Data extends Context.Tag('Data')<Data, DataService>() {}

/** How often a write starts again when a push or another first send landed. */
const WRITE_TRIES = 4
/** No new try starts once this much time has gone. */
const WRITE_BUDGET_MS = 10_000
const MiB = 1024 * 1024
/** A text file's content is read up to this size. */
const READ_TEXT_BYTES = MiB
/** A folder read gives at most this many files, and this much content. */
const READ_FOLDER_FILES = 1_000
const READ_FOLDER_BYTES = 10 * MiB
/** Text by its name, whatever type it was pushed with. */
const TEXT_FILE =
  /\.(md|markdown|csv|tsv|txt|svg|js|mjs|css|json|html?|xml|ya?ml)$/i

const sizeText = (bytes: number) =>
  bytes >= MiB
    ? `${Math.round((bytes / MiB) * 10) / 10} MiB`
    : `${bytes.toLocaleString('en-US')} bytes`

const notFound = (path: string | null) =>
  dossierError(
    'not_found',
    'Nothing is here, or you cannot open it.',
    'Check the path, or ask someone who can open it to share it with you.',
    path,
  )

const formChanged = () =>
  dossierError('form_changed', undefined, 'Reload the page, then send again.')

const DAY_MONTH = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
})

/** What a closed form says. */
const closedError = (row: FormRow) =>
  dossierError(
    'closed',
    row.closesAt !== null && !row.closed
      ? `This form closed on ${DAY_MONTH.format(new Date(row.closesAt))}`
      : 'This form is closed.',
    null,
  )

const isClosed = (row: FormRow, now: number) =>
  row.closed || (row.closesAt !== null && row.closesAt <= now)

const folderOf = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

/** A target without its trailing slash: 'answers/' → 'answers'. */
const bare = (target: string) =>
  target.endsWith('/') ? target.slice(0, -1) : target

/**
 * The writer's own folder in a target: `answers/sara@acme.com` for a folder
 * target, `decisions.files/sara@acme.com` beside a shared file.
 */
const ownFolder = (row: FormRow, email: string) =>
  row.kind === 'shared'
    ? `${row.targetPath.replace(/\.json$/i, '')}.files/${email}`
    : `${bare(row.targetPath)}/${email}`

/** Where a writer's uploads go, inside their own folder. */
const uploadsFolder = (row: FormRow, email: string) =>
  row.kind === 'shared'
    ? ownFolder(row, email)
    : `${ownFolder(row, email)}/files`

const isUploadValue = (value: unknown): value is UploadValue =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as UploadValue).file === 'string' &&
  typeof (value as UploadValue).name === 'string'

/** A file's own name made into one a node may have. */
export const safeName = (name: string): string => {
  const last = name.split(/[\\/]/).pop() ?? ''
  const cleaned = last
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/^[._]+/, '')
  let out = cleaned
  while (new TextEncoder().encode(out).length > 255) out = out.slice(0, -1)
  return out === '' || !isNodeName(out) ? 'file' : out
}

/** A path inside the tree every segment of which is a name. */
const isTreePath = (path: string) =>
  path !== '' &&
  path.split('/').length <= MAX_DEPTH &&
  path.split('/').every(isNodeName)

/** 2026-10-10T09-14-03: an entry's name, by the UTC time it was sent. */
const entryStamp = (now: number) =>
  new Date(now).toISOString().slice(0, 19).replaceAll(':', '-')

/** Drops nulls, as merging into nothing would. */
const withoutNulls = (values: Readonly<Record<string, unknown>>): JsonObject =>
  Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== null),
  ) as JsonObject

/**
 * A merge patch applied to nothing, as RFC 7396 says: a null removes its
 * key at every depth, an object is merged into an empty one, anything else
 * (arrays included) stands as it is.
 */
const intoNothing = (patch: Readonly<Record<string, unknown>>): JsonObject =>
  Object.fromEntries(
    Object.entries(patch).flatMap(([key, value]) =>
      value === null
        ? []
        : [
            [
              key,
              typeof value === 'object' && !Array.isArray(value)
                ? intoNothing(value as Record<string, unknown>)
                : value,
            ],
          ],
    ),
  ) as JsonObject

const parseJson = (text: string | null): unknown => {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const asObject = (value: unknown): JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {}

/** Another push or another first send got there first: start again. */
const isRace = (error: { readonly code: string }) =>
  error.code === 'stale_head' || error.code === 'conflict'

export const DataLive: Layer.Layer<
  Data,
  never,
  TreeStore | Access | Bindings | Limits
> = Layer.effect(
  Data,
  Effect.gen(function* () {
    const store = yield* TreeStore
    const access = yield* Access
    const limits = yield* Limits
    const bindings = yield* Bindings
    const { DB, BLOBS } = bindings
    const context = yield* Effect.context<Bindings>()

    const query = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (error) => {
          console.error('A data read failed', error)
          return dossierError('unavailable')
        },
      })

    /**
     * The person sending, who must be the one the page was shown to: a tab
     * left open while someone else signed in never writes as them.
     */
    const signedIn = (message: string, as?: string | null) =>
      Effect.flatMap(CurrentCaller, (caller) =>
        caller.person === null
          ? Effect.fail(
              dossierError('sign_in_required', message, 'Sign in with Google.'),
            )
          : as !== undefined &&
              as !== null &&
              as.toLowerCase() !== caller.person.email.toLowerCase()
            ? Effect.fail(
                dossierError(
                  'sign_in_required',
                  'This page was opened by someone else. Sign in again to send it.',
                  'Sign in with Google.',
                ),
              )
            : Effect.succeed(caller.person),
      )

    const emailOf = (personId: string) =>
      query(() =>
        DB.prepare('select email, name from "user" where id = ?')
          .bind(personId)
          .first<{ email: string; name: string }>(),
      ).pipe(Effect.map((row) => row ?? { email: '', name: '' }))

    /** A data version as a read gives it. */
    const docOf = (path: string, version: VersionRow) =>
      Effect.gen(function* () {
        const writer = yield* emailOf(version.authorId)
        return {
          path,
          data:
            version.blobSha256 === null ? parseJson(version.jsonValue) : null,
          by: writer.email,
          at: new Date(version.createdAt).toISOString(),
          push: (version.seenPushNumber ?? 0) as PushNumber,
        } satisfies DocWire
      })

    const versionById = (id: string) =>
      query(() =>
        DB.prepare(
          `select v.*, n.path from node_versions v join nodes n on n.id = v.node_id
           where v.id = ?`,
        )
          .bind(id)
          .first<Record<string, unknown>>(),
      )

    /** Rows read raw back as a version, with its node's path. */
    const versionOfRaw = (row: Record<string, unknown>) => ({
      path: row.path as string,
      version: {
        id: row.id,
        nodeId: row.node_id,
        treeId: row.tree_id,
        revision: row.revision,
        authoredSeq: row.authored_seq,
        state: row.state,
        blobSha256: row.blob_sha256,
        jsonValue: row.json_value,
        size: row.size,
        contentType: row.content_type,
        authorId: row.author_id,
        keyId: row.key_id,
        pushId: row.push_id,
        seenPushNumber: row.seen_push_number,
        opId: row.op_id,
        createdAt: row.created_at,
      } as VersionRow,
    })

    const pushNumberOf = (version: VersionRow) =>
      version.pushId === null
        ? Effect.succeed(0 as PushNumber)
        : query(() =>
            DB.prepare('select number from pushes where id = ?')
              .bind(version.pushId)
              .first<{ number: number | null }>(),
          ).pipe(Effect.map((row) => (row?.number ?? 0) as PushNumber))

    /** The page and the tree layouts composed into it, at a sequence. */
    const hostsOf = (
      tree: TreeRow,
      page: { readonly node: NodeRow; readonly version: VersionRow },
      at: AuthoredSeq,
    ) =>
      Effect.gen(function* () {
        const sha = page.version.blobSha256 as Sha256 | null
        const analysis = sha === null ? null : yield* store.analysis(sha)
        if (analysis === null) return [page]
        const layouts = yield* composedLayouts({
          treeId: tree.id,
          page: { ...page, analysis },
          at,
        }).pipe(Effect.provide(context))
        return [
          page,
          ...layouts.map((l) => ({ node: l.node, version: l.version })),
        ]
      })

    /** The form row a host version holds with this target and id. */
    const formIn = (
      host: { readonly version: VersionRow } | undefined,
      form: FormRef,
    ) =>
      Effect.gen(function* () {
        if (host === undefined) return null
        const rows = yield* store.forms({ hostVersionId: host.version.id })
        return (
          rows.find(
            (row) =>
              row.targetPath === form.target && row.formKey === (form.id ?? ''),
          ) ?? null
        )
      })

    /**
     * The checks every send and upload makes: the page at the sequence the
     * person saw, respond on it, the form in its composition then and now,
     * and the form open in both.
     */
    const checkForm = (i: {
      readonly treeId: TreeId
      readonly page: string
      readonly seq: AuthoredSeq
      readonly form: FormRef
    }) =>
      Effect.gen(function* () {
        const found = yield* store.treeById(i.treeId)
        if (found === null) return yield* Effect.fail(notFound(i.page))
        const tree = found.tree
        const seen = yield* store.fileAt(tree.id, i.page, i.seq)
        if (seen === null || seen.node.origin !== 'authored') {
          return yield* Effect.fail(notFound(i.page))
        }
        const page = yield* access
          .require('respond', seen.node)
          .pipe(
            Effect.mapError((e) =>
              dossierError(e.code, e.message, e.fix, i.page),
            ),
          )
        const then = yield* hostsOf(tree, seen, i.seq)
        const seenRow = yield* formIn(
          then.find((h) => h.node.id === i.form.host),
          i.form,
        )
        if (seenRow === null) return yield* Effect.fail(formChanged())
        const live = yield* store.fileAt(tree.id, i.page)
        if (live === null || live.node.id !== seen.node.id) {
          return yield* Effect.fail(formChanged())
        }
        const now = yield* hostsOf(tree, live, tree.authoredSeq as AuthoredSeq)
        const currentRow = yield* formIn(
          now.find((h) => h.node.id === i.form.host),
          i.form,
        )
        if (currentRow === null) return yield* Effect.fail(formChanged())
        const at = yield* Clock.currentTimeMillis
        if (isClosed(seenRow, at))
          return yield* Effect.fail(closedError(seenRow))
        if (isClosed(currentRow, at)) {
          return yield* Effect.fail(closedError(currentRow))
        }
        return {
          tree,
          page,
          seenRow,
          seenPush: yield* pushNumberOf(seen.version),
        }
      })

    /** The live data file at a path, with its version. */
    const liveData = (treeId: TreeId, path: string) =>
      Effect.map(store.fileAt(treeId, path), (found) =>
        found !== null && found.node.origin === 'data' ? found : null,
      )

    /** A live data folder the caller owns, or a missing one. */
    const liveNode = (treeId: TreeId, path: string) =>
      query(() =>
        DB.prepare(
          `select id, kind, origin, owner_id as ownerId from nodes
           where tree_id = ? and path = ? and deleted_at is null`,
        )
          .bind(treeId, path)
          .first<{
            id: NodeId
            kind: 'file' | 'folder'
            origin: 'authored' | 'data'
            ownerId: string | null
          }>(),
      )

    /** Runs a write again while pushes or other first sends race it. */
    const retrying = <A, E extends { readonly code: string }, R>(
      attempt: Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis
        for (let tried = 1; ; tried += 1) {
          const outcome = yield* Effect.either(attempt)
          if (outcome._tag === 'Right') return outcome.right
          const error = outcome.left
          const elapsed = (yield* Clock.currentTimeMillis) - started
          if (!isRace(error)) return yield* Effect.fail(error)
          if (tried >= WRITE_TRIES || elapsed > WRITE_BUDGET_MS) {
            console.error('A data write kept losing to other changes')
            return yield* Effect.fail(dossierError('unavailable'))
          }
          yield* Effect.sleep(20 * 2 ** tried)
        }
      })

    const tooLargeData = (limit: number) =>
      dossierError(
        'too_large',
        `These answers would make the data file larger than ${sizeText(limit)}, the most one data file may hold.`,
        'A super admin can raise it.',
      )

    /** Whether the caller reads the live data file at a path now. */
    const readsNow = (treeId: TreeId, path: string) =>
      Effect.gen(function* () {
        const found = yield* liveData(treeId, path)
        if (found === null) return false
        return yield* access.require('read', found.node).pipe(Effect.isSuccess)
      })

    const send: DataService['send'] = (i) =>
      Effect.gen(function* () {
        const person = yield* signedIn('Sign in to send this.', i.as)
        const scope = `${i.treeId}:${i.form.target}`
        const key = { principal: person.id, scope, opId: i.opId }
        const replay = () =>
          Effect.gen(function* () {
            const first = yield* store.operationResult(key)
            if (first === null) return null
            if (first.state === 'withdrawn') {
              return { doc: null, replayed: true } satisfies SendResult
            }
            const raw = yield* versionById(first.version.id)
            const path = raw === null ? '' : versionOfRaw(raw).path
            const doc = yield* docOf(path, first.version)
            // Only someone who reads the file gets it back; what this send
            // wrote is not kept apart, so a replay answers without it.
            return {
              doc: (yield* readsNow(i.treeId, path))
                ? doc
                : { ...doc, data: null },
              replayed: true,
            } satisfies SendResult
          })
        // A retry after a lost answer is answered before anything is counted.
        const early = yield* replay()
        if (early !== null) return early
        yield* limits.take('send', person.id)
        const { dataFileBytes } = yield* limits.current()
        const email = person.email.toLowerCase()

        const once = Effect.gen(function* () {
          const again = yield* replay()
          if (again !== null) return again
          const checked = yield* checkForm(i)
          const { tree, page, seenRow, seenPush } = checked
          // Every upload a send names is one of the caller's own in their
          // folder, recorded as the stored file is, whatever the send says.
          const own = ownFolder(seenRow, email)
          const entries: FieldEntry[] = []
          for (const [field, value] of i.entries) {
            if (typeof value === 'string') {
              entries.push([field, value])
              continue
            }
            const stored = value.file
              .split('/')
              .some((s) => s === '..' || s === '.' || s === '')
              ? null
              : yield* liveData(tree.id, `${own}/${value.file}`)
            if (
              stored === null ||
              stored.node.ownerId !== person.id ||
              stored.version.blobSha256 === null
            ) {
              return yield* Effect.fail(
                dossierError(
                  'invalid',
                  'This file was not uploaded with this form. Choose the file again.',
                  null,
                  field,
                ),
              )
            }
            entries.push([
              field,
              {
                file: value.file,
                name: stored.node.name,
                size: stored.version.size ?? 0,
                type: stored.version.contentType ?? 'application/octet-stream',
              },
            ])
          }
          const check = validateSend(seenRow.schema, entries, i.submitter)
          if (!check.ok) {
            const [problem] = check.problems
            return yield* Effect.fail(
              dossierError(
                'invalid',
                problem?.message ?? 'This answer is not valid.',
                null,
                problem?.field ?? null,
              ),
            )
          }
          const values = check.values as Readonly<Record<string, unknown>>
          yield* limits.requireStorage(
            tree.workspaceId,
            new TextEncoder().encode(JSON.stringify(values)).length,
          )
          const provenance = { seenPush, opId: i.opId }
          const target = seenRow.targetPath
          let path: string
          let existing: NodeRow | null = null
          let entryFolder: string | null = null
          if (seenRow.kind === 'person') {
            path = `${bare(target)}/${email}.json`
          } else if (seenRow.kind === 'shared') {
            path = target
          } else if (i.entry !== null) {
            path = i.entry
            if (folderOf(path) !== own) {
              return yield* Effect.fail(notFound(i.entry))
            }
          } else {
            entryFolder = own
            const stamp = entryStamp(yield* Clock.currentTimeMillis)
            path = `${own}/${stamp}.json`
            for (let n = 2; (yield* liveNode(tree.id, path)) !== null; n += 1) {
              path = `${own}/${stamp}-${n}.json`
            }
          }
          if (!isTreePath(path)) {
            return yield* Effect.fail(
              dossierError(
                'invalid',
                'These answers cannot be stored under this name.',
              ),
            )
          }
          const found = yield* liveData(tree.id, path)
          if (found !== null) {
            existing = found.node
            if (seenRow.kind !== 'shared' && found.node.ownerId !== person.id) {
              return yield* Effect.fail(notFound(path))
            }
            // A shared file belongs to nobody: a form never merges into
            // someone's own answers, whatever its action names.
            if (seenRow.kind === 'shared' && found.node.ownerId !== null) {
              return yield* Effect.fail(
                dossierError(
                  'forbidden',
                  'This form writes to someone’s own answers, so it cannot be sent.',
                  null,
                  path,
                ),
              )
            }
          } else if (i.entry !== null) {
            return yield* Effect.fail(notFound(i.entry))
          }
          const granted =
            existing === null
              ? null
              : yield* access.require('respond', existing)
          const ownMissing =
            entryFolder !== null &&
            (yield* liveNode(tree.id, entryFolder)) === null
          const plan = (cs: ChangeSet) =>
            Effect.sync(() => {
              // The forms checked above are the tree's forms as it stands.
              cs.guardHead('', tree.authoredSeq as AuthoredSeq)
              let version: VersionHandle
              let node: NodeHandle | Granted<'respond' | 'write'>
              if (granted !== null) {
                node = granted
                version = cs.mergeJson(
                  granted,
                  values as JsonObject,
                  provenance,
                )
              } else {
                if (entryFolder !== null && ownMissing) {
                  // The writer's own folder of entries is theirs.
                  cs.createData(page, {
                    path: entryFolder,
                    kind: 'folder',
                    owner: person.id,
                  })
                }
                node = cs.createData(page, {
                  path,
                  kind: 'file',
                  owner: seenRow.kind === 'shared' ? null : person.id,
                })
                version = cs.putData(node, {
                  ...provenance,
                  json: withoutNulls(values),
                })
              }
              cs.operation({
                principal: person.id,
                scope,
                opId: i.opId,
                result: version,
              })
              cs.event({
                type:
                  seenRow.kind === 'entries' && i.entry === null
                    ? 'entry'
                    : 'submission',
                path,
                node,
              })
              return { version }
            })
          const done = yield* store
            .change(tree.id, plan)
            .pipe(
              Effect.mapError((error) =>
                error.code === 'too_large' &&
                error.message === DATA_FILE_TOO_LARGE
                  ? tooLargeData(dataFileBytes)
                  : error,
              ),
            )
          const raw = yield* versionById(versionIdOf(done.version))
          if (raw === null)
            return yield* Effect.fail(dossierError('unavailable'))
          const stored = versionOfRaw(raw)
          const doc = yield* docOf(stored.path, stored.version)
          // A sender who may not read the file gets back only what they wrote.
          return {
            doc: (yield* readsNow(tree.id, stored.path))
              ? doc
              : { ...doc, data: values as JsonObject },
            replayed: false,
          } satisfies SendResult
        })
        return yield* retrying(once)
      }) as ReturnType<DataService['send']>

    /**
     * The page the person saw, at the sequence they saw it, with respond on
     * it: what an upload from page code needs, which no form names.
     */
    const checkPage = (i: {
      readonly treeId: TreeId
      readonly page: string
      readonly seq: AuthoredSeq
    }) =>
      Effect.gen(function* () {
        const found = yield* store.treeById(i.treeId)
        if (found === null) return yield* Effect.fail(notFound(i.page))
        const seen = yield* store.fileAt(found.tree.id, i.page, i.seq)
        if (seen === null || seen.node.origin !== 'authored') {
          return yield* Effect.fail(notFound(i.page))
        }
        const page = yield* access
          .require('respond', seen.node)
          .pipe(
            Effect.mapError((e) =>
              dossierError(e.code, e.message, e.fix, i.page),
            ),
          )
        return {
          tree: found.tree,
          page,
          seenPush: yield* pushNumberOf(seen.version),
        }
      })

    /**
     * Page code's upload: stored beside the page as
     * `<page name>.uploads/<email>/<name>`, owned by the uploader, under a
     * name no other upload holds, so an upload never changes another.
     */
    const uploadBeside = (i: UploadInput) =>
      Effect.gen(function* () {
        const person = yield* signedIn('Sign in to send this.', i.as)
        const email = person.email.toLowerCase()
        const own = `${i.page.replace(/\.html$/i, '')}.uploads/${email}`
        const scope = `${i.treeId}:${own}`
        const key = { principal: person.id, scope, opId: i.opId }
        const recorded = () =>
          Effect.gen(function* () {
            const first = yield* store.operationResult(key)
            if (first === null) return null
            if (first.state === 'withdrawn') {
              return yield* Effect.fail(notFound(null))
            }
            const raw = yield* versionById(first.version.id)
            if (raw === null) return yield* Effect.fail(notFound(null))
            const { path, version } = versionOfRaw(raw)
            return {
              path,
              file: path.slice(own.length + 1),
              name: path.slice(path.lastIndexOf('/') + 1),
              size: version.size ?? 0,
              type: version.contentType ?? 'application/octet-stream',
            } satisfies UploadResult
          })
        const early = yield* recorded()
        if (early !== null) return early
        yield* limits.take('send', person.id)
        const limit = yield* limits.current()
        if (i.size > limit.uploadBytes) {
          return yield* Effect.fail(
            dossierError(
              'too_large',
              `This file is ${sizeText(i.size)}; an upload may be at most ${sizeText(limit.uploadBytes)}.`,
              'A super admin can raise it.',
            ),
          )
        }
        const { tree, page, seenPush } = yield* checkPage(i)
        const name = safeName(i.name)
        if (!isTreePath(`${own}/${name}`)) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              'This file cannot be stored under its name.',
            ),
          )
        }
        const ownNode = yield* liveNode(tree.id, own)
        if (
          ownNode !== null &&
          (ownNode.kind !== 'folder' ||
            ownNode.origin !== 'data' ||
            ownNode.ownerId !== person.id)
        ) {
          return yield* Effect.fail(
            dossierError('forbidden', undefined, null, own),
          )
        }
        // Each request holds its own bytes, so two tries of one op ID never
        // let go of each other's hold.
        const holder = {
          kind: 'upload',
          id: `${person.id}:${i.opId}:${crypto.randomUUID()}`,
        } as const
        // The hold comes first, so a purge never takes the bytes being written.
        yield* store.holdBlob(holder, i.sha256, i.size)
        yield* Effect.tryPromise({
          try: async () => {
            const sized = new FixedLengthStream(i.size)
            const piped = i.body.pipeTo(sized.writable)
            await Promise.all([
              BLOBS.put(blobKey(i.sha256), sized.readable, {
                sha256: i.sha256,
              }),
              piped,
            ])
          },
          catch: () =>
            dossierError(
              'invalid',
              'The file does not match its size or SHA-256.',
              'Send the file again.',
            ),
        }).pipe(Effect.tapError(() => store.dropHold(holder, i.sha256)))
        yield* store.confirmHold(holder, i.sha256, i.size)
        const type = i.type.trim() === '' ? 'application/octet-stream' : i.type
        const dot = name.lastIndexOf('.')
        const [base, ext] =
          dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
        const once = Effect.gen(function* () {
          // Another try of this op ID stored it meanwhile: answer with that.
          const again = yield* recorded()
          if (again !== null) return again
          // A name no live node holds: cv.pdf, then cv-2.pdf, cv-3.pdf …
          let path = `${own}/${name}`
          for (let n = 2; (yield* liveNode(tree.id, path)) !== null; n += 1) {
            path = `${own}/${base}-${n}${ext}`
          }
          const folder = yield* liveNode(tree.id, own)
          yield* store.change(tree.id, (cs) =>
            Effect.sync(() => {
              cs.guardHead('', tree.authoredSeq as AuthoredSeq)
              if (folder === null) {
                cs.createData(page, {
                  path: own,
                  kind: 'folder',
                  owner: person.id,
                })
              }
              const node = cs.createData(page, {
                path,
                kind: 'file',
                owner: person.id,
              })
              const version = cs.putData(node, {
                seenPush,
                opId: i.opId,
                blob: {
                  sha256: i.sha256,
                  size: i.size,
                  contentType: type,
                  hold: holder,
                },
              })
              cs.operation({
                principal: person.id,
                scope,
                opId: i.opId,
                result: version,
              })
              cs.event({ type: 'data_write', path, node })
              return {}
            }),
          )
          return path
        })
        const stored = yield* retrying(once).pipe(
          Effect.tapError(() => store.releaseHold(holder, i.sha256)),
        )
        if (typeof stored !== 'string') {
          yield* store.releaseHold(holder, i.sha256)
          return stored
        }
        const path = stored
        return {
          path,
          file: path.slice(own.length + 1),
          name: path.slice(path.lastIndexOf('/') + 1),
          size: i.size,
          type,
        } satisfies UploadResult
      })

    const upload: DataService['upload'] = (i) =>
      Effect.gen(function* () {
        // Page code's upload names no form: it is stored beside the page.
        if (i.form === null && i.field === null) return yield* uploadBeside(i)
        const person = yield* signedIn('Sign in to send this.', i.as)
        if (i.form === null || i.field === null) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              'An upload names the form and the field it belongs to.',
            ),
          )
        }
        const form = i.form
        const field = i.field
        const scope = `${i.treeId}:${form.target}`
        const key = { principal: person.id, scope, opId: i.opId }
        const email = person.email.toLowerCase()
        const recorded = () =>
          Effect.gen(function* () {
            const first = yield* store.operationResult(key)
            if (first === null) return null
            if (first.state === 'withdrawn') {
              return yield* Effect.fail(notFound(null))
            }
            const raw = yield* versionById(first.version.id)
            if (raw === null) return yield* Effect.fail(notFound(null))
            const { path, version } = versionOfRaw(raw)
            const name = path.slice(path.lastIndexOf('/') + 1)
            const own = yield* ownOf(path)
            return {
              path,
              file: path.slice(own.length + 1),
              name,
              size: version.size ?? 0,
              type: version.contentType ?? 'application/octet-stream',
            } satisfies UploadResult
          })
        // The folder the upload sits in is the writer's folder or its files/.
        const ownOf = (path: string) =>
          Effect.succeed(
            folderOf(path).endsWith('/files')
              ? folderOf(folderOf(path))
              : folderOf(path),
          )
        const early = yield* recorded()
        if (early !== null) return early
        yield* limits.take('send', person.id)
        const limit = yield* limits.current()
        if (i.size > limit.uploadBytes) {
          return yield* Effect.fail(
            dossierError(
              'too_large',
              `This file is ${sizeText(i.size)}; a file sent with a form may be at most ${sizeText(limit.uploadBytes)}.`,
              'A super admin can raise it.',
              field,
            ),
          )
        }
        const checked = yield* checkForm({
          treeId: i.treeId,
          page: i.page,
          seq: i.seq,
          form,
        })
        const { tree, page, seenRow, seenPush } = checked
        const rule = seenRow.schema.fields.find((f) => f.name === field)
        if (rule === undefined || rule.type !== 'file') {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              'This form has no file field by that name.',
              null,
              field,
            ),
          )
        }
        if (rule.accept !== null && !acceptsFile(rule.accept, i)) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              'Choose a file of a type this field accepts.',
              null,
              field,
            ),
          )
        }
        yield* limits.requireStorage(tree.workspaceId, i.size)
        const name = safeName(i.name)
        const own = ownFolder(seenRow, email)
        const folder = uploadsFolder(seenRow, email)
        if (!isTreePath(`${folder}/${name}`)) {
          return yield* Effect.fail(
            dossierError(
              'invalid',
              'This file cannot be stored under its name.',
              null,
              field,
            ),
          )
        }
        // A hold of this request's own: overlapping tries of one op ID never
        // take each other's.
        const holder = {
          kind: 'upload',
          id: `${person.id}:${i.opId}:${newId()}`,
        } as const
        const reclaiming = () =>
          dossierError(
            'blob_reclaiming',
            'This file is being cleaned up. Send it again shortly.',
            'Try again in a minute.',
            field,
          )
        // The hold comes first, so a purge never takes the bytes being written.
        yield* store
          .holdBlob(holder, i.sha256, i.size)
          .pipe(Effect.mapError(() => reclaiming()))
        yield* Effect.tryPromise({
          try: async () => {
            const sized = new FixedLengthStream(i.size)
            const piped = i.body.pipeTo(sized.writable)
            await Promise.all([
              BLOBS.put(blobKey(i.sha256), sized.readable, {
                sha256: i.sha256,
              }),
              piped,
            ])
          },
          catch: () =>
            dossierError(
              'invalid',
              'The file does not match its size or SHA-256.',
              'Send the file again.',
              field,
            ),
        }).pipe(Effect.tapError(() => store.dropHold(holder, i.sha256)))
        yield* store.confirmHold(holder, i.sha256, i.size)
        const type = i.type.trim() === '' ? 'application/octet-stream' : i.type
        /** `cv.pdf`, then `cv-2.pdf`, `cv-3.pdf`: never an earlier upload's. */
        const named = (n: number): string => {
          if (n === 1) return name
          const dot = name.lastIndexOf('.')
          return dot > 0
            ? `${name.slice(0, dot)}-${n}${name.slice(dot)}`
            : `${name}-${n}`
        }
        const once = Effect.gen(function* () {
          // Another try of this op ID may have stored it meanwhile.
          const stored = yield* recorded()
          if (stored !== null) return { result: stored, mine: false }
          let path = `${folder}/${named(1)}`
          for (let n = 2; (yield* liveNode(tree.id, path)) !== null; n += 1) {
            path = `${folder}/${named(n)}`
          }
          if (!isTreePath(path)) {
            return yield* Effect.fail(
              dossierError(
                'invalid',
                'This file cannot be stored under its name.',
                null,
                field,
              ),
            )
          }
          const ownNode = yield* liveNode(tree.id, own)
          const filesNode =
            folder === own ? ownNode : yield* liveNode(tree.id, folder)
          yield* store.change(tree.id, (cs) =>
            Effect.sync(() => {
              cs.guardHead('', tree.authoredSeq as AuthoredSeq)
              if (ownNode === null) {
                cs.createData(page, {
                  path: own,
                  kind: 'folder',
                  owner: person.id,
                })
              }
              if (folder !== own && filesNode === null) {
                cs.createData(page, {
                  path: folder,
                  kind: 'folder',
                  owner: person.id,
                })
              }
              // Always a new file: an upload is never a version of another.
              const node = cs.createData(page, {
                path,
                kind: 'file',
                owner: person.id,
              })
              const version = cs.putData(node, {
                seenPush,
                opId: i.opId,
                blob: {
                  sha256: i.sha256,
                  size: i.size,
                  contentType: type,
                  hold: holder,
                },
              })
              cs.operation({
                principal: person.id,
                scope,
                opId: i.opId,
                result: version,
              })
              cs.event({ type: 'data_write', path, node })
              return {}
            }),
          )
          return {
            result: {
              path,
              file: path.slice(own.length + 1),
              name: path.slice(path.lastIndexOf('/') + 1),
              size: i.size,
              type,
            } satisfies UploadResult,
            mine: true,
          }
        })
        const outcome = yield* retrying(once).pipe(
          Effect.catchAll((error) =>
            // A try that lost to another of the same op ID answers with it.
            Effect.flatMap(recorded(), (stored) =>
              stored !== null
                ? Effect.succeed({ result: stored, mine: false })
                : Effect.fail(
                    error.code === 'blob_reclaiming' ? reclaiming() : error,
                  ),
            ),
          ),
          Effect.tapError(() => store.releaseHold(holder, i.sha256)),
        )
        if (!outcome.mine) yield* store.releaseHold(holder, i.sha256)
        return outcome.result
      }) as ReturnType<DataService['upload']>

    /** The upload paths a data version's values name, from its own folder. */
    const uploadsNamed = (json: string | null, own: string): string[] => {
      const out: string[] = []
      const value = asObject(parseJson(json))
      for (const field of Object.values(value)) {
        const list = Array.isArray(field) ? field : [field]
        for (const item of list) {
          if (isUploadValue(item)) out.push(`${own}/${item.file}`)
        }
      }
      return out
    }

    const withdraw: DataService['withdraw'] = (i) =>
      Effect.gen(function* () {
        const person = yield* signedIn('Sign in to withdraw this.', i.as)
        const scope = `${i.treeId}:${i.path}`
        const done = yield* store.operationResult({
          principal: person.id,
          scope,
          opId: i.opId,
        })
        if (done !== null) return
        const found = yield* store.treeById(i.treeId)
        if (found === null) return yield* Effect.fail(notFound(i.path))
        const file = yield* liveData(i.treeId, i.path)
        if (file === null) return yield* Effect.fail(notFound(i.path))
        if (file.node.ownerId === null) {
          // Shared files are deleted by write holders, never withdrawn.
          yield* access.require('read', file.node)
          return yield* Effect.fail(
            dossierError(
              'forbidden',
              'A shared file belongs to nobody, so it cannot be withdrawn.',
              null,
              i.path,
            ),
          )
        }
        const granted = yield* access.require('withdraw-own', file.node)
        const email = person.email.toLowerCase()
        // The folder an answer's uploads sit in: `answers/<email>` beside a
        // person file, the folder an entry is in.
        const ownOfAnswer = (path: string) =>
          path.slice(path.lastIndexOf('/') + 1) === `${email}.json`
            ? path.slice(0, -'.json'.length)
            : folderOf(path)
        const own = ownOfAnswer(i.path)
        const once = Effect.gen(function* () {
          // The uploads this answer named, and every upload of theirs in its
          // folder that no other answer names: ones a failed or changed send
          // left behind.
          const versions = yield* query(() =>
            DB.prepare(
              'select json_value as json from node_versions where node_id = ?',
            )
              .bind(file.node.id)
              .all<{ json: string | null }>(),
          )
          const named = new Set(
            versions.results.flatMap((v) => uploadsNamed(v.json, own)),
          )
          const loose = yield* query(() =>
            DB.prepare(
              `select path from nodes where tree_id = ? and owner_id = ?
                 and origin = 'data' and kind = 'file' and deleted_at is null
                 and substr(path, 1, length(?3) + 7) = ?3 || '/files/'`,
            )
              .bind(i.treeId, person.id, own)
              .all<{ path: string }>(),
          )
          for (const { path } of loose.results) named.add(path)
          // Each other answer names uploads relative to its own folder.
          const others = yield* query(() =>
            DB.prepare(
              `select n.path, v.json_value as json from nodes n
                 join node_versions v on v.id = n.current_version_id
               where n.tree_id = ? and n.owner_id = ? and n.origin = 'data'
                 and n.deleted_at is null and n.id <> ? and v.json_value is not null`,
            )
              .bind(i.treeId, person.id, file.node.id)
              .all<{ path: string; json: string | null }>(),
          )
          for (const other of others.results) {
            for (const path of uploadsNamed(
              other.json,
              ownOfAnswer(other.path),
            ))
              named.delete(path)
          }
          const uploads: Granted<'withdraw-own'>[] = []
          for (const path of named) {
            const kept = yield* liveData(i.treeId, path)
            if (kept === null || kept.node.ownerId !== person.id) continue
            const ok = yield* access
              .require('withdraw-own', kept.node)
              .pipe(Effect.option)
            if (ok._tag === 'Some') uploads.push(ok.value)
          }
          // The writer's folders this leaves empty go too, innermost first.
          const folders: Granted<'withdraw-own'>[] = []
          for (const path of [`${own}/files`, own]) {
            const row = yield* folderOrFile(i.treeId, path)
            if (
              row === null ||
              row.kind !== 'folder' ||
              row.ownerId !== person.id
            )
              continue
            const ok = yield* access
              .require('withdraw-own', row)
              .pipe(Effect.option)
            if (ok._tag === 'Some') folders.push(ok.value)
          }
          yield* store.change(i.treeId, (cs) =>
            Effect.sync(() => {
              // An answer written since this read that names one of these
              // uploads fails the change, which reads again.
              cs.guardUnnamed({
                owner: person.id,
                own,
                files: uploads.map((u) => u.path.slice(own.length + 1)),
                except: file.node.id,
              })
              cs.markDeleted(granted, 'withdrawn')
              for (const kept of uploads) cs.markDeleted(kept, 'withdrawn')
              for (const folder of folders) cs.markDeleted(folder, 'withdrawn')
              cs.operation({
                principal: person.id,
                scope,
                opId: i.opId,
                result: 'withdrawn',
              })
              cs.event({ type: 'withdrawal', path: i.path, node: granted })
              return {}
            }),
          )
        })
        yield* retrying(once).pipe(
          Effect.mapError((error) =>
            error.code === 'blob_reclaiming'
              ? notFound(i.path)
              : error.code === 'not_mergeable' ||
                  error.code === 'too_large' ||
                  error.code === 'stale_head' ||
                  error.code === 'conflict'
                ? dossierError('unavailable')
                : error,
          ),
        )
      }) as ReturnType<DataService['withdraw']>

    /** The forms in the tree as it stands that send to a target. */
    /** Every form of the tree as it stands now. */
    /**
     * The forms of a page as it is now, its own and its composed layouts',
     * whose answers hold the path: under a folder target, a shared file, or
     * a shared file's uploads.
     */
    const formsHolding = (
      tree: TreeRow,
      page: { readonly node: NodeRow; readonly version: VersionRow },
      path: string,
    ) =>
      Effect.gen(function* () {
        const hosts = yield* hostsOf(
          tree,
          page,
          tree.authoredSeq as AuthoredSeq,
        )
        const held = []
        for (const host of hosts) {
          for (const row of yield* store.forms({
            hostVersionId: host.version.id,
          })) {
            const holds =
              row.kind === 'shared'
                ? row.targetPath === path ||
                  path.startsWith(
                    `${row.targetPath.replace(/\.json$/i, '')}.files/`,
                  )
                : path.startsWith(row.targetPath)
            if (holds) held.push(row)
          }
        }
        return held
      })

    const currentForms = (treeId: TreeId) =>
      query(() =>
        DB.prepare(
          `select f.kind, f.target_path as target, f.closes_at as closesAt,
             f.closed, f.schema_json as schema, f.form_key as formKey,
             f.host_version_id as hostVersionId, f.host_node_id as hostNodeId,
             f.line, f.title, f.tree_id as treeId
           from forms f join nodes n on n.id = f.host_node_id
             and n.current_version_id = f.host_version_id and n.deleted_at is null
           where f.tree_id = ?`,
        )
          .bind(treeId)
          .all<{
            kind: FormRow['kind']
            target: string
            closesAt: number | null
            closed: number
            schema: string
            formKey: string
            hostVersionId: string
            hostNodeId: string
            line: number
            title: string | null
            treeId: string
          }>(),
      ).pipe(
        Effect.map((rows) =>
          rows.results.map((row): FormRow => ({
            hostVersionId: row.hostVersionId as FormRow['hostVersionId'],
            hostNodeId: row.hostNodeId as NodeId,
            treeId: row.treeId as TreeId,
            targetPath: row.target,
            formKey: row.formKey,
            kind: row.kind,
            closesAt: row.closesAt,
            closed: row.closed === 1,
            line: row.line,
            title: row.title,
            schema: JSON.parse(row.schema) as FormRow['schema'],
          })),
        ),
      )

    const forbidden = (path: string, message?: string) =>
      dossierError('forbidden', message, null, path)

    const write: DataService['write'] = (i) =>
      Effect.gen(function* () {
        const person = yield* signedIn('Sign in to save this.', i.as)
        const email = person.email.toLowerCase()
        const scope = `${i.tree}:${i.path}`
        const key = { principal: person.id, scope, opId: i.opId }
        /**
         * The stored file as the writer may read it. A respond holder who
         * cannot read a shared file gets back only what this write wrote,
         * never other people's values.
         */
        const answerOf = (path: string, version: VersionRow) =>
          Effect.gen(function* () {
            const doc = yield* docOf(path, version)
            const node = yield* folderOrFile(i.tree, path)
            const reads =
              node !== null &&
              (yield* access.require('read', node).pipe(Effect.isSuccess))
            return reads ? doc : { ...doc, data: intoNothing(i.patch) }
          })
        const replay = () =>
          Effect.gen(function* () {
            const first = yield* store.operationResult(key)
            if (first === null) return null
            if (first.state === 'withdrawn') {
              return yield* Effect.fail(notFound(i.path))
            }
            const raw = yield* versionById(first.version.id)
            if (raw === null) return yield* Effect.fail(notFound(i.path))
            const stored = versionOfRaw(raw)
            return yield* answerOf(stored.path, stored.version)
          })
        // A retry after a lost answer is answered before anything is counted.
        const early = yield* replay()
        if (early !== null) return early
        yield* limits.take('send', person.id)
        const { dataFileBytes } = yield* limits.current()
        const patch = i.patch as unknown
        if (
          typeof patch !== 'object' ||
          patch === null ||
          Array.isArray(patch)
        ) {
          return yield* Effect.fail(
            dossierError(
              'not_mergeable',
              'A write is a JSON object of the values to change.',
              null,
              i.path,
            ),
          )
        }
        const written = patch as JsonObject
        const isFolder = i.path.endsWith('/')
        const bareTarget = bare(i.path)
        const segments = bareTarget.split('/')
        if (
          i.path === '' ||
          !isTreePath(bareTarget) ||
          (!isFolder && !/\.json$/i.test(bareTarget))
        ) {
          return yield* Effect.fail(
            forbidden(
              i.path,
              'Page code writes only .json data files, or a new entry in a folder.',
            ),
          )
        }
        if (segments.some((segment) => segment.startsWith('_'))) {
          return yield* Effect.fail(
            forbidden(i.path, 'Page code never writes a _ file.'),
          )
        }
        // A name holding '@' is someone's own: only the caller's may be named.
        const stem = (segment: string, last: boolean) =>
          last && !isFolder ? segment.replace(/\.json$/i, '') : segment
        if (
          segments.some(
            (segment, n) =>
              segment.includes('@') &&
              stem(segment, n === segments.length - 1).toLowerCase() !== email,
          )
        ) {
          return yield* Effect.fail(
            forbidden(i.path, "This is another person's file."),
          )
        }
        const checked = yield* checkPage({
          treeId: i.tree,
          page: i.page,
          seq: i.seq,
        }).pipe(
          Effect.mapError((e) =>
            e.code === 'not_found' || e.code === 'forbidden'
              ? forbidden(i.page, 'This page cannot write here.')
              : e,
          ),
        )
        const { tree, seenPush } = checked

        const once = Effect.gen(function* () {
          const again = yield* replay()
          if (again !== null) return again
          let path: string
          let entryFolder: string | null = null
          if (isFolder) {
            const last = segments[segments.length - 1] ?? ''
            entryFolder =
              last.toLowerCase() === email
                ? bareTarget
                : `${bareTarget}/${email}`
            const stamp = entryStamp(yield* Clock.currentTimeMillis)
            path = `${entryFolder}/${stamp}.json`
            for (let n = 2; (yield* liveNode(tree.id, path)) !== null; n += 1) {
              path = `${entryFolder}/${stamp}-${n}.json`
            }
            if (!isTreePath(path)) {
              return yield* Effect.fail(
                dossierError('invalid', 'This entry cannot be stored here.'),
              )
            }
          } else {
            path = bareTarget
          }
          const existing = yield* folderOrFile(tree.id, path)
          let owner: string | null
          if (existing !== null) {
            if (
              existing.kind !== 'file' ||
              existing.origin !== 'data' ||
              (existing.ownerId !== null && existing.ownerId !== person.id)
            ) {
              return yield* Effect.fail(forbidden(path))
            }
            owner = existing.ownerId
          } else {
            const name = path.slice(path.lastIndexOf('/') + 1)
            const ownsName =
              name.toLowerCase() === `${email}.json` ||
              entryFolder !== null ||
              folderOf(path).split('/').at(-1)?.toLowerCase() === email
            owner = ownsName ? person.id : null
          }
          if (i.replace && owner !== person.id) {
            return yield* Effect.fail(
              forbidden(path, 'Only your own file can be replaced whole.'),
            )
          }
          // The writer's own folder, when the entry or file sits in one.
          const ownFolderPath =
            entryFolder ??
            (owner !== null &&
            folderOf(path).split('/').at(-1)?.toLowerCase() === email
              ? folderOf(path)
              : null)
          const ownNode =
            ownFolderPath === null
              ? null
              : yield* folderOrFile(tree.id, ownFolderPath)
          if (
            ownNode !== null &&
            (ownNode.kind !== 'folder' ||
              ownNode.origin !== 'data' ||
              (ownNode.ownerId !== null && ownNode.ownerId !== person.id))
          ) {
            return yield* Effect.fail(forbidden(path))
          }
          // Respond on the file, or on the closest folder above a new one.
          let granted: Granted<'respond'> | null = null
          let under: Granted<'respond'> | null = null
          if (existing !== null) {
            granted = yield* access.require('respond', existing)
          } else {
            const above = yield* store.nearest(tree.id, folderOf(path))
            if (above === null || above.kind !== 'folder') {
              return yield* Effect.fail(forbidden(path))
            }
            const onFolder = yield* access
              .require('respond', above)
              .pipe(Effect.either)
            if (onFolder._tag === 'Right') {
              under = onFolder.right
            } else {
              // A respondent through the page alone answers where a form of
              // the page, or of a layout composed into it, writes.
              const page = yield* store.fileAt(tree.id, i.page)
              const writesHere =
                page !== null &&
                (yield* formsHolding(tree, page, path)).length > 0
              if (!writesHere) return yield* Effect.fail(onFolder.left)
              under = yield* access.require('respond', page.node)
            }
          }
          // Every form whose answers hold this path: under a folder target at
          // any depth, a shared file, or a shared file's uploads.
          const holding = (yield* currentForms(tree.id)).filter((row) =>
            row.kind === 'shared'
              ? row.targetPath === path ||
                path.startsWith(
                  `${row.targetPath.replace(/\.json$/i, '')}.files/`,
                )
              : path.startsWith(row.targetPath),
          )
          let values = written
          if (holding.length > 0) {
            const now = yield* Clock.currentTimeMillis
            const open = holding.filter((row) => !isClosed(row, now))
            if (open.length === 0) {
              return yield* Effect.fail(closedError(holding[0]!))
            }
            // Only the shape a form stores: the shared file itself, a
            // person's own file, or an entry in their own folder.
            const stores = open.filter((row) => {
              if (row.kind === 'shared') return row.targetPath === path
              const rest = path.slice(row.targetPath.length).toLowerCase()
              return row.kind === 'person'
                ? rest === `${email}.json`
                : rest.startsWith(`${email}/`) &&
                    !rest.slice(email.length + 1).includes('/') &&
                    rest.endsWith('.json')
            })
            if (stores.length === 0) {
              return yield* Effect.fail(
                forbidden(
                  path,
                  "This folder holds a form's answers, which are stored only as the form stores them.",
                ),
              )
            }
            // Every upload named is one of the writer's own for the form,
            // taken as the stored file is, whatever the write says, before
            // the form's rules look at it.
            const rebuilt: Record<string, Json> = { ...values }
            for (const [field, value] of Object.entries(values)) {
              const row = stores.find((r) =>
                r.schema.fields.some(
                  (f) => f.name === field && f.type === 'file',
                ),
              )
              if (row === undefined || value === null) continue
              const own = ownFolder(row, email)
              const list = Array.isArray(value) ? value : [value]
              const stored: Json[] = []
              for (const item of list) {
                const file =
                  isUploadValue(item) &&
                  !item.file
                    .split('/')
                    .some(
                      (part) => part === '..' || part === '.' || part === '',
                    )
                    ? yield* liveData(tree.id, `${own}/${item.file}`)
                    : null
                if (
                  file === null ||
                  file.node.ownerId !== person.id ||
                  file.version.blobSha256 === null
                ) {
                  return yield* Effect.fail(
                    dossierError(
                      'invalid',
                      'This file was not uploaded with this form. Choose the file again.',
                      null,
                      field,
                    ),
                  )
                }
                stored.push({
                  file: (item as { file: string }).file,
                  name: file.node.name,
                  size: file.version.size ?? 0,
                  type: file.version.contentType ?? 'application/octet-stream',
                })
              }
              rebuilt[field] = Array.isArray(value) ? stored : stored[0]!
            }
            values = rebuilt as JsonObject
            const check = validateValues(
              stores.map((row) => row.schema),
              values,
            )
            if (!check.ok) {
              const [problem] = check.problems
              return yield* Effect.fail(
                dossierError(
                  'invalid',
                  problem?.message ?? 'This value is not valid.',
                  null,
                  problem?.field ?? null,
                ),
              )
            }
          }
          // An early refusal; the batch's storage guard decides.
          yield* limits.requireStorage(
            tree.workspaceId,
            new TextEncoder().encode(JSON.stringify(values)).length,
          )
          const provenance = { seenPush, opId: i.opId }
          const done = yield* store
            .change(tree.id, (cs) =>
              Effect.sync(() => {
                // The forms checked above are the tree's forms as it stands.
                cs.guardHead('', tree.authoredSeq as AuthoredSeq)
                let version: VersionHandle
                let node: NodeHandle | Granted<'respond'>
                if (granted !== null) {
                  node = granted
                  version = i.replace
                    ? cs.putData(granted, { ...provenance, json: values })
                    : cs.mergeJson(granted, values, provenance)
                } else {
                  // The writer's own folder is theirs, made before the file.
                  if (ownFolderPath !== null && ownNode === null) {
                    cs.createData(under!, {
                      path: ownFolderPath,
                      kind: 'folder',
                      owner: person.id,
                    })
                  }
                  node = cs.createData(under!, {
                    path,
                    kind: 'file',
                    owner: owner === null ? null : person.id,
                  })
                  version = cs.putData(node, {
                    ...provenance,
                    json: i.replace ? values : intoNothing(values),
                  })
                }
                cs.operation({
                  principal: person.id,
                  scope,
                  opId: i.opId,
                  result: version,
                })
                cs.event({
                  type: entryFolder !== null ? 'entry' : 'data_write',
                  path,
                  node,
                })
                return { version }
              }),
            )
            .pipe(
              Effect.mapError((error) =>
                // Only the data file's own limit is reworded; the
                // workspace's storage limit speaks for itself.
                error.code === 'too_large' &&
                error.message === DATA_FILE_TOO_LARGE
                  ? tooLargeData(dataFileBytes)
                  : error.code === 'blob_reclaiming'
                    ? dossierError('unavailable')
                    : error,
              ),
            )
          const raw = yield* versionById(versionIdOf(done.version))
          if (raw === null)
            return yield* Effect.fail(dossierError('unavailable'))
          const stored = versionOfRaw(raw)
          return yield* answerOf(stored.path, stored.version)
        })
        return yield* retrying(once)
      }) as ReturnType<DataService['write']>

    /** What a read gives of a file's content. */
    const contentOf = (doc: DocRow) =>
      Effect.gen(function* () {
        const { node, version } = doc
        if (node.origin === 'data') {
          return version.blobSha256 === null
            ? parseJson(version.jsonValue)
            : null
        }
        const json = /\.json$/i.test(node.path)
        const text =
          json ||
          (version.contentType ?? '').startsWith('text/') ||
          TEXT_FILE.test(node.path)
        if (!text || (version.size ?? 0) > READ_TEXT_BYTES) return null
        const granted = yield* access.require('read', node).pipe(Effect.option)
        if (granted._tag === 'None') return null
        const file = yield* store.read(granted.value).pipe(Effect.option)
        if (file._tag === 'None') return null
        const body = file.value.body
        const bytes =
          typeof body === 'string'
            ? body
            : yield* query(() => new Response(body).text())
        if (!json) return bytes
        try {
          return JSON.parse(bytes) as unknown
        } catch {
          return bytes
        }
      })

    /** The bytes a file's content adds to a folder read. */
    const readBytes = (doc: DocRow) => {
      const { node, version } = doc
      if (node.origin === 'data') {
        return version.blobSha256 === null ? (version.size ?? 0) : 0
      }
      const text =
        /\.json$/i.test(node.path) ||
        (version.contentType ?? '').startsWith('text/') ||
        TEXT_FILE.test(node.path)
      return text && (version.size ?? 0) <= READ_TEXT_BYTES
        ? (version.size ?? 0)
        : 0
    }

    const wireOf = (doc: DocRow) =>
      Effect.map(contentOf(doc), (data): DocWire => ({
        path: doc.node.path,
        data,
        by: doc.by,
        at: new Date(doc.version.createdAt).toISOString(),
        push: doc.push,
      }))

    const read: DataService['read'] = (i) =>
      Effect.gen(function* () {
        const folder = i.path === '' || i.path.endsWith('/')
        const path = bare(i.path)
        const row = yield* folderOrFile(i.treeId, path)
        if (folder) {
          if (row === null || row.kind !== 'folder') return { files: [] }
          const granted = yield* access.require('read', row).pipe(Effect.option)
          if (granted._tag === 'None') return { files: [] }
          const prefix = path === '' ? '' : `${path}/`
          const docs = (yield* store.docs(granted.value, {
            origin: 'any',
          })).filter(
            (doc) =>
              !doc.node.path
                .slice(prefix.length)
                .split('/')
                .some((segment) => segment.startsWith('_')),
          )
          const bytes = docs.reduce((sum, doc) => sum + readBytes(doc), 0)
          if (docs.length > READ_FOLDER_FILES || bytes > READ_FOLDER_BYTES) {
            return yield* Effect.fail(
              dossierError(
                'too_large',
                `This folder holds ${docs.length.toLocaleString('en-US')} files and ${sizeText(bytes)} to read; a read takes at most ${READ_FOLDER_FILES.toLocaleString('en-US')} files and ${sizeText(READ_FOLDER_BYTES)}.`,
                'Read a smaller folder.',
                i.path,
              ),
            )
          }
          return {
            files: yield* Effect.forEach(docs, wireOf, { concurrency: 8 }),
          }
        }
        if (row === null || row.kind !== 'file') return { file: null }
        const granted = yield* access.require('read', row).pipe(Effect.option)
        if (granted._tag === 'None') return { file: null }
        const doc = yield* docRowOf(granted.value)
        return { file: doc === null ? null : yield* wireOf(doc) }
      })

    /** One file as a read names it, by the rule of TreeStore.docs. */
    const docRowOf = (node: NodeRow) =>
      Effect.gen(function* () {
        const caller = yield* CurrentCaller
        const raw = yield* query(() =>
          DB.prepare(
            `select v.*, u.email, u.name, p.number as pushNumber,
               exists (select 1 from workspace_members m join trees t
                 on t.workspace_id = m.workspace_id
                 where t.id = v.tree_id and m.user_id = ?2) as member
             from node_versions v join "user" u on u.id = v.author_id
               left join pushes p on p.id = v.push_id
             where v.id = ?1 and v.state = 'live'`,
          )
            .bind(node.currentVersionId, caller.person?.id ?? '')
            .first<Record<string, unknown>>(),
        )
        if (raw === null) return null
        const { version } = versionOfRaw({ ...raw, path: node.path })
        const data = node.origin === 'data'
        const named =
          data ||
          raw.member === 1 ||
          (caller.person !== null && caller.person.id === version.authorId)
        return {
          node,
          version,
          by: (named ? raw.email : raw.name) as string,
          push: ((data ? version.seenPushNumber : raw.pushNumber) ??
            0) as PushNumber,
          value: null,
        } satisfies DocRow
      })

    /** Whether the caller reads the answers a target collects. */
    const readsData = (treeId: TreeId, target: string) =>
      Effect.gen(function* () {
        const segments = bare(target).split('/')
        // The target, or the closest node above it while it has no answers.
        for (let depth = segments.length; depth >= 0; depth -= 1) {
          const row = yield* folderOrFile(
            treeId,
            segments.slice(0, depth).join('/'),
          )
          if (row === null) continue
          return yield* access.require('read-data', row).pipe(Effect.isSuccess)
        }
        return false
      })

    /** A live node as its row. */
    const folderOrFile = (treeId: TreeId, path: string) =>
      Effect.gen(function* () {
        const raw = yield* query(() =>
          DB.prepare(
            `select id, tree_id, parent_id, name, path, depth, kind, origin, owner_id,
               current_version_id, created_at, deleted_at
             from nodes where tree_id = ? and path = ? and deleted_at is null`,
          )
            .bind(treeId, path)
            .first<Record<string, unknown>>(),
        )
        return raw === null ? null : nodeOfRaw(raw)
      })

    /** People who answered: owners of answers, and writers of shared files. */
    const peopleIn = (treeId: TreeId, targets: readonly string[]) =>
      Effect.gen(function* () {
        if (targets.length === 0) return 0
        const row = yield* query(() =>
          DB.prepare(
            `select count(distinct who) as people from (
               select n.owner_id as who from nodes n, json_each(?2) t
               where n.tree_id = ?1 and n.deleted_at is null and n.kind = 'file'
                 and n.origin = 'data' and n.owner_id is not null
                 and substr(t.value, -1) = '/'
                 and substr(n.path, 1, length(t.value)) = t.value
                 -- Answers only: a person's file, or an entry in their
                 -- folder; never an upload.
                 and n.path like '%.json'
                 and n.depth - (length(t.value) - length(replace(t.value, '/', '')))
                   between 1 and 2
                 and instr(substr(n.path, length(t.value) + 1), '/files/') = 0
               union
               select v.author_id as who from nodes n
                 join node_versions v on v.node_id = n.id, json_each(?2) t
               where n.tree_id = ?1 and n.deleted_at is null and n.kind = 'file'
                 and n.origin = 'data' and n.path = t.value and v.state = 'live')`,
          )
            .bind(treeId, JSON.stringify(targets))
            .first<{ people: number }>(),
        )
        return row?.people ?? 0
      })

    /** A page's forms now: the page's and its layouts', by host and target. */
    const formsNow = (
      tree: TreeRow,
      page: { node: NodeRow; version: VersionRow },
    ) =>
      Effect.gen(function* () {
        const hosts = yield* hostsOf(
          tree,
          page,
          tree.authoredSeq as AuthoredSeq,
        )
        const out: FormRow[] = []
        for (const host of hosts) {
          for (const row of yield* store.forms({
            hostVersionId: host.version.id,
          })) {
            out.push(row)
          }
        }
        return out
      })

    const pageForms: DataService['pageForms'] = (folder) =>
      Effect.gen(function* () {
        const out = new Map<NodeId, PageForms>()
        const found = yield* store.treeById(folder.treeId)
        if (found === null) return out
        const entries = yield* store.list(folder, 'one')
        for (const entry of entries) {
          if (entry.kind !== 'page') continue
          const path =
            entry.node.kind === 'folder'
              ? `${entry.path}/index.html`
              : entry.path
          const page = yield* store.fileAt(folder.treeId, path)
          if (page === null || page.node.origin !== 'authored') continue
          const rows = yield* formsNow(found.tree, page)
          if (rows.length === 0) continue
          const targets = [...new Set(rows.map((r) => r.targetPath))]
          let readable = true
          for (const target of targets) {
            if (!(yield* readsData(folder.treeId, target))) readable = false
          }
          out.set(entry.node.id, {
            targets,
            people: readable ? yield* peopleIn(folder.treeId, targets) : null,
          })
        }
        return out
      })

    /** The page a link names, following one redirect; read checked. */
    const pageOf = (ref: LinkRef) =>
      Effect.gen(function* () {
        let resolved = yield* store.resolve(ref)
        if (!('missing' in resolved) && resolved.kind === 'redirect') {
          const to = resolved.to
          const folder = to.endsWith('/')
          const decoded = (folder ? to.slice(0, -1) : to)
            .split('/')
            .map(decodeURIComponent)
            .join('/')
          resolved = yield* store.resolve({
            treeId: resolved.tree.id,
            path: decoded,
            folder,
          })
        }
        if ('missing' in resolved || resolved.kind !== 'page') {
          yield* access.require(
            'read',
            'missing' in resolved
              ? resolved
              : { missing: true, treeId: null, path: ref.path },
          )
          return yield* Effect.fail(notFound(ref.path))
        }
        yield* access.require('read', resolved.node).pipe(
          Effect.catchIf(
            (e) => e.code === 'forbidden',
            () => Effect.fail(notFound(ref.path)),
          ),
        )
        return resolved
      })

    /** Every live answer file of a form, as rows. */
    const answersOf = (tree: TreeRow, row: FormRow) =>
      Effect.gen(function* () {
        if (row.kind === 'shared') return []
        const folder = bare(row.targetPath)
        const depth = folder.split('/').length + (row.kind === 'person' ? 1 : 2)
        const rows = yield* query(() =>
          DB.prepare(
            `select n.path, n.id, v.json_value as json, v.created_at as at,
               v.seen_push_number as push, u.email, u.name,
               (select count(*) from node_versions r where r.node_id = n.id
                  and r.state = 'live') as revisions
             from nodes n join node_versions v on v.id = n.current_version_id
               join "user" u on u.id = n.owner_id
             where n.tree_id = ?1 and n.deleted_at is null and n.kind = 'file'
               and n.origin = 'data' and n.depth = ?3 and v.json_value is not null
               and substr(n.path, 1, length(?2) + 1) = ?2 || '/'
               and n.path like '%.json'
             order by v.created_at desc`,
          )
            .bind(tree.id, folder, depth)
            .all<{
              path: string
              json: string | null
              at: number
              push: number | null
              email: string
              name: string
              revisions: number
            }>(),
        )
        return rows.results.map((r): ResponseRow => ({
          path: r.path,
          email: r.email,
          name: r.name,
          at: r.at,
          push: (r.push ?? 0) as PushNumber,
          revisions: r.revisions,
          values: asObject(parseJson(r.json)),
        }))
      })

    /** A shared file's fields, each with who changed it last. */
    const sharedOf = (tree: TreeRow, row: FormRow) =>
      Effect.gen(function* () {
        const file = yield* liveData(tree.id, row.targetPath)
        if (file === null) return []
        const versions = yield* query(() =>
          DB.prepare(
            `select v.json_value as json, v.created_at as at, u.email
             from node_versions v join "user" u on u.id = v.author_id
             where v.node_id = ? and v.state = 'live' order by v.revision`,
          )
            .bind(file.node.id)
            .all<{ json: string | null; at: number; email: string }>(),
        )
        const last = new Map<string, { by: string; at: number }>()
        let previous: JsonObject = {}
        for (const v of versions.results) {
          const value = asObject(parseJson(v.json))
          for (const key of Object.keys(value)) {
            if (JSON.stringify(value[key]) !== JSON.stringify(previous[key])) {
              last.set(key, { by: v.email, at: v.at })
            }
          }
          previous = value
        }
        return Object.entries(previous).map(([field, value]) => ({
          field,
          value,
          by: last.get(field)?.by ?? '',
          at: last.get(field)?.at ?? 0,
        }))
      })

    const responses: DataService['responses'] = (ref) =>
      Effect.gen(function* () {
        const page = yield* pageOf(ref)
        const rows = yield* formsNow(page.tree, page)
        const seen = new Set<string>()
        const forms: FormResponses[] = []
        let hidden = 0
        for (const row of rows) {
          const id = `${row.hostNodeId}|${row.targetPath}|${row.formKey}`
          if (seen.has(id)) continue
          seen.add(id)
          if (!(yield* readsData(page.tree.id, row.targetPath))) {
            hidden += 1
            continue
          }
          const answers = yield* answersOf(page.tree, row)
          const shared =
            row.kind === 'shared' ? yield* sharedOf(page.tree, row) : null
          forms.push({
            form: {
              host: row.hostNodeId,
              target: row.targetPath,
              id: row.formKey === '' ? null : row.formKey,
              kind: row.kind,
              title: row.title,
              fields: row.schema.fields
                .filter((f) => f.type !== 'submit' || f.options.length > 1)
                .map((f) => ({
                  name: f.name,
                  label: f.label ?? f.name,
                  type: f.type,
                })),
            },
            people:
              row.kind === 'shared'
                ? yield* peopleIn(page.tree.id, [row.targetPath])
                : new Set(answers.map((a) => a.email)).size,
            rows: answers,
            shared,
          })
        }
        if (forms.length === 0 && hidden > 0) {
          return yield* Effect.fail(
            dossierError(
              'forbidden',
              'You can open this page but not read its answers.',
              null,
              ref.path,
            ),
          )
        }
        const sha = page.version.blobSha256 as Sha256 | null
        const analysis = sha === null ? null : yield* store.analysis(sha)
        return {
          page: {
            path: page.node.path,
            title: analysis?.title || page.node.name,
            link: page.linkPath,
          },
          forms,
        } satisfies Responses
      }) as ReturnType<DataService['responses']>

    const revisions: DataService['revisions'] = (i) =>
      Effect.gen(function* () {
        const page = yield* pageOf(i.ref)
        const rows = yield* formsNow(page.tree, page)
        const target = rows.find((row) => {
          const folder = `${bare(row.targetPath)}/`
          return row.kind === 'shared'
            ? row.targetPath === i.path
            : i.path.startsWith(folder)
        })
        if (target === undefined) return yield* Effect.fail(notFound(i.path))
        if (!(yield* readsData(page.tree.id, target.targetPath))) {
          return yield* Effect.fail(
            dossierError('forbidden', undefined, null, i.path),
          )
        }
        const file = yield* liveData(page.tree.id, i.path)
        if (file === null) return yield* Effect.fail(notFound(i.path))
        yield* access.require('read', file.node)
        const versions = yield* query(() =>
          DB.prepare(
            `select v.revision, v.created_at as at, v.seen_push_number as push,
               v.json_value as json, u.email
             from node_versions v join "user" u on u.id = v.author_id
             where v.node_id = ? and v.state = 'live' order by v.revision desc`,
          )
            .bind(file.node.id)
            .all<{
              revision: number
              at: number
              push: number | null
              json: string | null
              email: string
            }>(),
        )
        return versions.results.map((v): Revision => ({
          revision: v.revision,
          at: v.at,
          push: (v.push ?? 0) as PushNumber,
          by: v.email,
          values: asObject(parseJson(v.json)),
        }))
      }) as ReturnType<DataService['revisions']>

    /** The person's live data nodes, files first, deepest folders first. */
    const mine = (personId: string) =>
      query(() =>
        DB.prepare(
          `select n.id, n.tree_id, n.parent_id, n.name, n.path, n.depth, n.kind, n.origin,
             n.owner_id, n.current_version_id, n.created_at, n.deleted_at,
             v.blob_sha256 is not null as upload,
             coalesce(p.owner_id = n.owner_id, 0) as inOwnFolder
           from nodes n
           left join node_versions v on v.id = n.current_version_id
           left join nodes p on p.id = n.parent_id
           where n.owner_id = ? and n.origin = 'data' and n.deleted_at is null
           order by n.tree_id, n.kind = 'folder', n.depth desc, n.path`,
        )
          .bind(personId)
          .all<Record<string, unknown>>(),
      ).pipe(
        Effect.map((rows) =>
          rows.results.map((raw) => ({
            node: nodeOfRaw(raw),
            kind: (raw.kind === 'folder'
              ? 'folder'
              : raw.upload === 1
                ? 'upload'
                : raw.inOwnFolder === 1
                  ? 'entry'
                  : 'submission') as
              | 'folder'
              | 'upload'
              | 'entry'
              | 'submission',
          })),
        ),
      )

    /** Something live below the folder belongs to someone else. */
    const holdsOthers = (folder: NodeRow, personId: string) =>
      query(() =>
        DB.prepare(
          `select 1 as one from nodes c where c.tree_id = ?1 and c.deleted_at is null
             and substr(c.path, 1, length(?2) + 1) = ?2 || '/'
             and (c.owner_id is null or c.owner_id <> ?3)
           limit 1`,
        )
          .bind(folder.treeId, folder.path, personId)
          .first<{ one: number }>(),
      ).pipe(Effect.map((row) => row !== null))

    const countsOf = (
      rows: readonly { readonly kind: string }[],
    ): MineCounts => ({
      submissions: rows.filter((r) => r.kind === 'submission').length,
      entries: rows.filter((r) => r.kind === 'entry').length,
      uploads: rows.filter((r) => r.kind === 'upload').length,
    })

    const mineCounts: DataService['mineCounts'] = () =>
      Effect.gen(function* () {
        const person = yield* signedIn('Sign in to see your answers.')
        return countsOf(yield* mine(person.id))
      })

    /** Nodes withdrawn per change, so a batch stays small. */
    const WITHDRAW_CHUNK = 40

    const withdrawMine: DataService['withdrawMine'] = () =>
      Effect.gen(function* () {
        const person = yield* signedIn('Sign in to delete your answers.')
        const rows = yield* mine(person.id)
        const byTree = new Map<TreeId, (typeof rows)[number][]>()
        for (const row of rows) {
          const list = byTree.get(row.node.treeId) ?? []
          list.push(row)
          byTree.set(row.node.treeId, list)
        }
        let trees = 0
        for (const [treeId, list] of byTree) {
          const granted: {
            readonly node: Granted<'withdraw-own'>
            readonly file: boolean
          }[] = []
          for (const row of list) {
            // A folder of theirs holding someone else's data stays.
            if (
              row.kind === 'folder' &&
              (yield* holdsOthers(row.node, person.id))
            ) {
              continue
            }
            const ok = yield* access
              .require('withdraw-own', row.node)
              .pipe(Effect.option)
            if (ok._tag === 'Some') {
              granted.push({ node: ok.value, file: row.kind !== 'folder' })
            }
          }
          if (granted.length === 0) continue
          // Files go before the folders that hold them, which go last.
          for (let at = 0; at < granted.length; at += WITHDRAW_CHUNK) {
            const chunk = granted.slice(at, at + WITHDRAW_CHUNK)
            yield* retrying(
              store.change(treeId, (cs) =>
                Effect.sync(() => {
                  for (const { node, file } of chunk) {
                    cs.markDeleted(node, 'withdrawn')
                    if (file) {
                      cs.event({ type: 'withdrawal', path: node.path, node })
                    }
                  }
                  if (chunk.every((g) => !g.file)) {
                    const first = chunk[0]?.node
                    if (first !== undefined) {
                      cs.event({
                        type: 'withdrawal',
                        path: first.path,
                        node: first,
                      })
                    }
                  }
                  return {}
                }),
              ),
            ).pipe(
              Effect.mapError((error) => {
                if (error.code !== 'unavailable') {
                  console.error('Withdrawing answers failed', error.code)
                }
                return dossierError('unavailable')
              }),
            )
          }
          trees += 1
        }
        return { ...countsOf(rows), trees }
      })

    return {
      send,
      upload,
      withdraw,
      withdrawMine,
      mineCounts,
      write,
      read,
      pageForms,
      responses,
      revisions,
    } satisfies DataService
  }),
)

const versionIdOf = (h: VersionHandle): string =>
  (h as unknown as { readonly id: string }).id

const nodeOfRaw = (raw: Record<string, unknown>): NodeRow =>
  ({
    id: raw.id,
    treeId: raw.tree_id,
    parentId: raw.parent_id,
    name: raw.name,
    path: raw.path,
    depth: raw.depth,
    kind: raw.kind,
    origin: raw.origin,
    ownerId: raw.owner_id,
    currentVersionId: raw.current_version_id,
    createdAt: raw.created_at,
    deletedAt: raw.deleted_at,
    underscoreFrom: null,
  }) as NodeRow
