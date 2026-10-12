import { randomUUID } from 'node:crypto'
import {
  constants,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { Args, Command, Options } from '@effect/cli'
import { EXPORT_LINKED_HEADER, type LinkRef, linkFor } from '@dossier/contracts'
import { Effect, Option } from 'effect'

import { rawCall } from '../client.ts'
import { attempt } from '../deployment.ts'
import { Cli } from '../io.ts'
import { CliProblem, jsonOption, problem } from '../render.ts'
import { resolveTarget } from '../target.ts'
import { readPath, sizeText } from './read.ts'

/** What `dossier export --json` prints. */
export interface ExportOutcome {
  /** The saved file's absolute path. */
  readonly file: string
  readonly bytes: number
  /** Canonical links to the media kept out of the file to fit its limit. */
  readonly linked: readonly string[]
}

/** The longest file name an export is saved under, before `.html`. */
const MAX_STEM = 200

/**
 * A name an export may be saved under: the last segment only, no control
 * characters, no leading dots, ending in `.html`. Null when nothing is left.
 */
export const plainName = (raw: string): string | null => {
  const last = raw.split(/[\\/]/).pop() ?? ''
  const visible = [...last]
    .filter((c) => c.charCodeAt(0) > 0x1f && c.charCodeAt(0) !== 0x7f)
    .join('')
  const stem = visible
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.html?$/i, '')
    .slice(0, MAX_STEM)
    .trim()
  return stem === '' || stem === '.' ? null : `${stem}.html`
}

/**
 * The file name a Content-Disposition header gives: `filename*` (UTF-8,
 * percent-encoded) before `filename`, quoted or not.
 */
export const dispositionName = (header: string | null): string | null => {
  if (header === null) return null
  const extended = /filename\*\s*=\s*([^;]+)/i.exec(header)?.[1]?.trim()
  if (extended !== undefined) {
    const match = /^([\w!#$%&+^`{}~-]+)'[^']*'(.*)$/.exec(extended)
    if (match !== null && match[1]?.toLowerCase() === 'utf-8') {
      try {
        const name = plainName(decodeURIComponent(match[2] ?? ''))
        if (name !== null) return name
      } catch {
        // A malformed extended name falls back to the plain one.
      }
    }
  }
  const quoted = /(?:^|;)\s*filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header)
  if (quoted !== null) {
    return plainName((quoted[1] ?? '').replace(/\\(.)/g, '$1'))
  }
  const token = /(?:^|;)\s*filename\s*=\s*([^;\s]+)/i.exec(header)
  return token === null ? null : plainName(token[1] ?? '')
}

/**
 * The name an export takes when the deployment names none: the page's last
 * segment without `.html`; an `index.html` takes its folder's name, and the
 * tree's root takes the tree's.
 */
export const exportName = (ref: LinkRef): string => {
  const segments = ref.path === '' ? [] : ref.path.split('/')
  let last = segments.pop()
  if (last !== undefined && /^index(\.html)?$/i.test(last) && !ref.folder) {
    last = segments.pop()
  }
  return plainName(last ?? ref.tree) ?? `${ref.tree}.html`
}

/** The tree paths the deployment linked instead of inlining, as it sent them. */
export const linkedPaths = (header: string | null): readonly string[] => {
  if (header === null || header.trim() === '') return []
  let value: unknown
  try {
    value = JSON.parse(decodeURIComponent(header))
  } catch {
    return []
  }
  return Array.isArray(value)
    ? value.filter((path): path is string => typeof path === 'string')
    : []
}

const NO_FOLLOW_CREATE =
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_WRONLY |
  constants.O_NOFOLLOW

const throughLink = (path: string) =>
  problem(
    `${path} is a symbolic link, so the export is not written through it.`,
    'Remove the link, or give another file with -o.',
  )

/**
 * Streams `body` into `path`: a temporary file beside it, opened without
 * following links, then renamed over the path once every byte is on disk.
 * A symbolic link at the path is refused. Answers the bytes written.
 */
const saveStream = async (
  body: ReadableStream<Uint8Array>,
  path: string,
  signal: AbortSignal,
): Promise<number> => {
  const reader = body.getReader()
  const stop = () => {
    reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', stop, { once: true })
  const folder = dirname(path)
  // A short name of its own: the saved name may already be as long as a
  // file name can be.
  const temporary = join(folder, `.dossier-export-${randomUUID()}.tmp`)
  let bytes = 0
  let saved = false
  try {
    await mkdir(folder, { recursive: true })
    const handle = await open(temporary, NO_FOLLOW_CREATE, 0o666)
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        let at = 0
        while (at < value.byteLength) {
          const { bytesWritten } = await handle.write(value, at)
          at += bytesWritten
        }
        bytes += value.byteLength
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    const existing = await lstat(path).catch(() => null)
    if (existing?.isSymbolicLink() === true) throw throughLink(path)
    await rename(temporary, path)
    saved = true
    return bytes
  } finally {
    signal.removeEventListener('abort', stop)
    if (!saved) stop()
    reader.releaseLock()
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** An existing folder, or a path written with a trailing slash. */
const namesFolder = async (given: string, path: string): Promise<boolean> =>
  /[\\/]$/.test(given) ||
  ((await stat(path).catch(() => null))?.isDirectory() ?? false)

/** What `dossier export` prints: where the file went and what was linked. */
export const describeExport = (name: string, outcome: ExportOutcome): string =>
  [
    `Saved ${name} (${sizeText(outcome.bytes)}).`,
    ...(outcome.linked.length === 0
      ? []
      : ['Linked, not included:', ...outcome.linked]),
  ].join('\n')

export const exportPage = Command.make(
  'export',
  {
    link: Args.text({ name: 'link' }).pipe(
      Args.withDescription(
        'The page to export: workspace/tree/path, or a link to it.',
      ),
    ),
    output: Options.text('output').pipe(
      Options.withAlias('o'),
      Options.withDescription(
        'The file to write; a folder takes the file under its usual name. ' +
          "Defaults to the page's name with .html in the current folder.",
      ),
      Options.optional,
    ),
    json: jsonOption,
  },
  ({ link, output: given }) =>
    Effect.gen(function* () {
      const { io, output } = yield* Cli
      const { remote, ref } = yield* resolveTarget(link)
      const response = yield* rawCall(remote.deployment, remote.key, {
        method: 'GET',
        path: `/_/api/export?link=${encodeURIComponent(readPath(ref))}`,
        accept: 'text/html',
      })
      const type = response.headers.get('content-type') ?? ''
      if (response.body === null || !/^text\/html\b/i.test(type)) {
        yield* Effect.promise(
          () =>
            response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
        )
        return yield* Effect.fail(
          problem(
            `${remote.deployment.id} answered the export with something ` +
              'this CLI does not understand.',
            'Run `dossier update` to get the CLI this deployment speaks.',
          ),
        )
      }
      const body = response.body
      const name =
        dispositionName(response.headers.get('content-disposition')) ??
        exportName(ref)
      const path = yield* Option.match(given, {
        onNone: () => Effect.succeed(resolve(io.cwd, name)),
        onSome: (file) => {
          const at = resolve(io.cwd, file)
          return Effect.map(
            attempt(() => namesFolder(file, at)),
            (folder) => (folder ? join(at, name) : at),
          )
        },
      })
      const bytes = yield* Effect.tryPromise({
        try: (signal) => saveStream(body, path, signal),
        catch: (error) =>
          error instanceof CliProblem
            ? error
            : problem(
                `Could not save the export to ${path}: ` +
                  `${error instanceof Error ? error.message : String(error)}.`,
                'Check the file and its folder, then export again.',
              ),
      })
      const origin = remote.deployment.origin
      const outcome: ExportOutcome = {
        file: path,
        bytes,
        linked: linkedPaths(response.headers.get(EXPORT_LINKED_HEADER)).map(
          (tree) =>
            linkFor(origin, {
              workspace: ref.workspace,
              tree: ref.tree,
              path: tree,
              kind: 'file',
            }),
        ),
      }
      output.result(describeExport(basename(path), outcome), outcome)
    }),
).pipe(
  Command.withDescription(
    'Save a page as one HTML file that opens offline: its layouts, theme, ' +
      'components, images, fonts and libraries inlined, with a snapshot of ' +
      'the data you can read. Forms in the file save only in that browser.',
  ),
)
