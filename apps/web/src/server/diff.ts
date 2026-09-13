import { isDocumentEditor } from '@dossier/contracts'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { Cause, Effect, Exit, Option } from 'effect'

/**
 * `Diff` is phase 4's other half (`src/services/diff.ts`):
 * `compare(documentId, {from?, to?, mode?}, principal) -> Effect<DiffResponse>`.
 * Its answer is read structurally below rather than destructured, so a later
 * change to the hunk contract degrades into a smaller diff, never a broken page.
 */
import { Diff, Documents } from '../services'
import {
  runSurface,
  toSurfaceFailure,
  type CoreServices,
  type SurfaceFailure,
} from './runtime'
import { resolveWeb, type Viewer } from './viewer'

type DiffServices = CoreServices | Diff

function runDiffSurface<A, E>(
  effect: Effect.Effect<A, E, DiffServices>,
): Promise<A | SurfaceFailure> {
  return runSurface(effect as Effect.Effect<A, E, CoreServices>)
}

/** `html` compares the stored bytes; `text` compares visible text only. */
export type DiffMode = 'html' | 'text'

/** What the reader asked the page to look like; `auto` follows the viewport. */
export type DiffLayout = 'auto' | 'side' | 'unified'

export type DiffOp = 'context' | 'add' | 'remove'

export interface DiffLine {
  readonly op: DiffOp
  readonly text: string
  /** True when this side's source ended without a final newline. */
  readonly noNewline: boolean
  /** Absent on an added line. */
  readonly oldNumber: number | null
  /** Absent on a removed line. */
  readonly newNumber: number | null
}

/**
 * One printed row of a side-by-side diff. A context row carries the same line
 * on both sides; a replacement pairs a removal with the addition that took its
 * place; a one-sided change leaves the other half `null` (an empty gutter on a
 * wide screen, nothing at all on a phone).
 */
export interface DiffRow {
  readonly old: DiffLine | null
  readonly added: DiffLine | null
}

export interface DiffHunk {
  /** 1-based, and the anchor for `n`/`p` navigation (`#hunk-3`). */
  readonly index: number
  readonly label: string
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly added: number
  readonly removed: number
  /** Unified order, exactly as the service emitted it. */
  readonly lines: readonly DiffLine[]
  /** The same lines paired for the two-column layout. */
  readonly rows: readonly DiffRow[]
}

/** A version as the pickers and the raw-link escape hatch need it. */
export interface DiffVersionRef {
  readonly versionNumber: number
  readonly createdAt: string
  readonly fileSize: number
  readonly url: string
  readonly rawUrl: string
  readonly current: boolean
}

export type DiffOutcome =
  | {
      readonly state: 'ok'
      readonly hunks: readonly DiffHunk[]
      readonly added: number
      readonly removed: number
      /** Set when the page kept only the first hunks of a very long diff. */
      readonly omittedHunks: number
    }
  | {
      /** 413: the service refused to diff these two versions. */
      readonly state: 'too_large'
      readonly message: string
    }
  | {
      readonly state: 'unavailable'
      readonly code: string
      readonly message: string
    }

export interface DiffData {
  readonly viewer: Viewer
  readonly documentId: string
  readonly documentTitle: string
  readonly documentKind: string | null
  readonly documentUrl: string
  /** Newest first, the same order the detail page lists them in. */
  readonly versions: readonly DiffVersionRef[]
  readonly versionCount: number
  readonly from: DiffVersionRef | null
  readonly to: DiffVersionRef | null
  /** What the URL asked for; `mode` is what the service actually produced. */
  readonly requestedMode: DiffMode
  readonly mode: DiffMode
  /** False hides the text-only toggle: this deployment cannot produce one. */
  readonly textSupported: boolean
  /** Null when the document has fewer than two versions to compare. */
  readonly outcome: DiffOutcome | null
}

/**
 * A diff of HTML can run to tens of thousands of lines. The service has its
 * own 413 ceiling; this is the page's: past it the remaining hunks are dropped
 * rather than shipped down the wire, and the reader is offered the raw files.
 */
const MAX_LINES = 4000

const ADD = new Set(['+', 'add', 'added', 'addition', 'insert', 'inserted'])
const REMOVE = new Set(['-', 'remove', 'removed', 'deletion', 'delete', 'deleted', 'del'])

function readOp(value: unknown, text: string): DiffOp {
  if (typeof value === 'string') {
    const token = value.trim().toLowerCase()
    if (ADD.has(token)) return 'add'
    if (REMOVE.has(token)) return 'remove'
    if (token === ' ' || token === '' || token === 'context' || token === 'equal') {
      return 'context'
    }
  }
  // No usable `op`: fall back to the unified-diff convention in the text.
  if (text.startsWith('+')) return 'add'
  if (text.startsWith('-')) return 'remove'
  return 'context'
}

function readCount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback
}

function readMode(value: unknown, fallback: DiffMode): DiffMode {
  return value === 'text' || value === 'html' ? value : fallback
}

/** True unless the service says, in one of the plausible ways, that it cannot. */
function readTextSupport(response: Record<string, unknown>): boolean | null {
  for (const key of ['textSupported', 'textAvailable', 'supportsText']) {
    const flag = response[key]
    if (typeof flag === 'boolean') return flag
  }
  const modes = response.modes
  if (Array.isArray(modes)) return modes.includes('text')
  return null
}

function pairRows(lines: readonly DiffLine[]): readonly DiffRow[] {
  const rows: DiffRow[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.op === 'context') {
      rows.push({ old: line, added: line })
      index += 1
      continue
    }
    const removed: DiffLine[] = []
    const added: DiffLine[] = []
    while (index < lines.length && lines[index].op === 'remove') {
      removed.push(lines[index])
      index += 1
    }
    while (index < lines.length && lines[index].op === 'add') {
      added.push(lines[index])
      index += 1
    }
    const height = Math.max(removed.length, added.length)
    for (let row = 0; row < height; row += 1) {
      rows.push({ old: removed[row] ?? null, added: added[row] ?? null })
    }
  }
  return rows
}

function readHunks(value: unknown): {
  readonly hunks: readonly DiffHunk[]
  readonly added: number
  readonly removed: number
  readonly omittedHunks: number
} {
  const source = Array.isArray(value) ? value : []
  const hunks: DiffHunk[] = []
  let added = 0
  let removed = 0
  let budget = MAX_LINES
  let omittedHunks = 0

  for (const entry of source) {
    const raw = (entry ?? {}) as Record<string, unknown>
    const oldStart = readCount(raw.oldStart, 1)
    const newStart = readCount(raw.newStart, 1)
    const rawLines = Array.isArray(raw.lines) ? raw.lines : []

    if (budget <= 0) {
      omittedHunks += 1
      continue
    }

    const keptLines = rawLines.slice(0, budget)
    if (keptLines.length < rawLines.length) omittedHunks += 1

    let oldNumber = oldStart
    let newNumber = newStart
    const lines: DiffLine[] = []
    let hunkAdded = 0
    let hunkRemoved = 0

    for (const rawLine of keptLines) {
      const cell = (rawLine ?? {}) as Record<string, unknown>
      const text = typeof cell.text === 'string' ? cell.text : ''
      const op = readOp(cell.op, text)
      const noNewline = cell.noNewline === true
      // Some emitters keep the marker in the text; the gutter renders it.
      const body =
        cell.op === undefined && (text.startsWith('+') || text.startsWith('-'))
          ? text.slice(1)
          : text
      if (op === 'add') {
        lines.push({ op, text: body, noNewline, oldNumber: null, newNumber })
        newNumber += 1
        hunkAdded += 1
      } else if (op === 'remove') {
        lines.push({ op, text: body, noNewline, oldNumber, newNumber: null })
        oldNumber += 1
        hunkRemoved += 1
      } else {
        lines.push({ op, text: body, noNewline, oldNumber, newNumber })
        oldNumber += 1
        newNumber += 1
      }
    }

    budget -= lines.length
    added += hunkAdded
    removed += hunkRemoved
    const index = hunks.length + 1
    const oldLines = readCount(raw.oldLines, oldNumber - oldStart)
    const newLines = readCount(raw.newLines, newNumber - newStart)
    hunks.push({
      index,
      label: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
      oldStart,
      oldLines,
      newStart,
      newLines,
      added: hunkAdded,
      removed: hunkRemoved,
      lines,
      rows: pairRows(lines),
    })
  }

  return { hunks, added, removed, omittedHunks }
}

/** The service's own 413; it is a tagged error, not a `DossierError`. */
function isTooLarge(error: unknown): error is { readonly message?: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { _tag?: unknown })._tag === 'DiffTooLarge'
  )
}

function isUnsupportedMode(cause: Cause.Cause<unknown>): boolean {
  const failure = Cause.failureOption(cause)
  if (Option.isNone(failure)) return false
  const code = toSurfaceFailure(failure.value).code
  return code === 'policy_rejected' || code === 'unsupported_mode'
}

function describeFailure(cause: Cause.Cause<unknown>): {
  readonly tooLarge: boolean
  readonly code: string
  readonly message: string
} {
  const failure = Cause.failureOption(cause)
  if (Option.isNone(failure)) {
    return {
      tooLarge: false,
      code: 'internal',
      message: 'The diff could not be computed.',
    }
  }
  if (isTooLarge(failure.value)) {
    return {
      tooLarge: true,
      code: 'diff_too_large',
      message:
        typeof failure.value.message === 'string'
          ? failure.value.message
          : 'These two versions are too large to compare here.',
    }
  }
  const surfaced = toSurfaceFailure(
    failure.value,
    'The diff could not be computed.',
  )
  return {
    tooLarge:
      surfaced.code === 'diff_too_large' || surfaced.code === 'body_too_large',
    code: surfaced.code,
    message: surfaced.message,
  }
}

export type DiffActionInput = {
  readonly id: string
  readonly from?: number
  readonly to?: number
  readonly mode?: DiffMode
}

function readVersionNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[0-9]{1,9}$/.test(value)
        ? Number(value)
        : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * `/dashboard/documents/$id/diff` — the document, its versions, and the diff
 * between the two the URL names. A diff that fails is an outcome on the page,
 * not a page error: the pickers and the raw links stay usable.
 */
export const loadDiff = createServerFn({ method: 'GET' })
  .validator((input: unknown): DiffActionInput => {
    const value = (input ?? {}) as Record<string, unknown>
    if (typeof value.id !== 'string' || !/^[a-z0-9]{12}$/.test(value.id)) {
      throw new Error('A 12-character document id is required.')
    }
    const from = readVersionNumber(value.from)
    const to = readVersionNumber(value.to)
    return {
      id: value.id,
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(value.mode === 'text' ? { mode: 'text' as const } : {}),
    }
  })
  .handler(async ({ data }) => {
    const request = getRequest()
    return runDiffSurface(
      Effect.gen(function* () {
        const { viewer, principal } = yield* resolveWeb(request)
        const documents = yield* Documents
        const result = yield* documents.get(data.id, principal)
        if (!isDocumentEditor(result.document)) {
          throw new Error('Document edit access is required.')
        }
        const document = result.document

        const latest = result.versions[0]?.versionNumber ?? null
        const versions: readonly DiffVersionRef[] = result.versions.map(
          (version) => ({
            versionNumber: version.versionNumber,
            createdAt: version.createdAt,
            fileSize: version.fileSize,
            url: version.url,
            rawUrl: version.rawUrl,
            current: version.versionNumber === latest,
          }),
        )
        const byNumber = new Map(
          versions.map((version) => [version.versionNumber, version]),
        )

        const requestedMode: DiffMode = data.mode === 'text' ? 'text' : 'html'
        const base = {
          viewer,
          documentId: document.id,
          documentTitle: document.title,
          documentKind: document.kind,
          documentUrl: document.url,
          versions,
          versionCount: document.versionCount,
          requestedMode,
        }

        if (versions.length < 2) {
          return {
            ...base,
            from: versions[0] ?? null,
            to: versions[0] ?? null,
            mode: requestedMode,
            textSupported: true,
            outcome: null,
          } satisfies DiffData
        }

        // Newest first, so the version after `to` in the list is the one
        // before it in time: previous versus current, as PLAN section 1 asks.
        const to =
          (data.to === undefined ? undefined : byNumber.get(data.to)) ??
          versions[0]
        const toIndex = versions.indexOf(to)
        const from =
          (data.from === undefined ? undefined : byNumber.get(data.from)) ??
          versions[toIndex + 1] ??
          versions[versions.length - 1]

        const attempt = (mode: DiffMode) =>
          Effect.exit(
            Effect.flatMap(Diff, (service) =>
              service.compare(
                document.id,
                {
                  from: from.versionNumber,
                  to: to.versionNumber,
                  mode,
                },
                principal,
              ),
            ),
          )

        // A deployment without a text differ refuses the mode rather than
        // advertising it. Asking once is how the page finds out; the html diff
        // is then shown anyway, and the toggle disappears.
        let textSupported = true
        let exit = yield* attempt(requestedMode)
        if (
          requestedMode === 'text' &&
          Exit.isFailure(exit) &&
          isUnsupportedMode(exit.cause)
        ) {
          textSupported = false
          exit = yield* attempt('html')
        }

        if (Exit.isFailure(exit)) {
          const failure = describeFailure(exit.cause)
          return {
            ...base,
            from,
            to,
            mode: requestedMode,
            textSupported,
            outcome: failure.tooLarge
              ? { state: 'too_large' as const, message: failure.message }
              : {
                  state: 'unavailable' as const,
                  code: failure.code,
                  message: failure.message,
                },
          } satisfies DiffData
        }

        const payload: unknown = exit.value
        const response = (payload ?? {}) as Record<string, unknown>
        const mode = readMode(response.mode, requestedMode)
        const { hunks, added, removed, omittedHunks } = readHunks(response.hunks)
        const stats = (response.stats ?? {}) as Record<string, unknown>

        // The service answers in `mode`; asking for text and being handed html
        // is the other way a deployment says "not available".
        const declared = readTextSupport(response)
        const resolvedTextSupport =
          declared ??
          (requestedMode === 'text' ? mode === 'text' && textSupported : textSupported)

        const resolve = (
          side: unknown,
          fallback: DiffVersionRef,
        ): DiffVersionRef => {
          const value = (side ?? {}) as Record<string, unknown>
          const number = readVersionNumber(value.versionNumber)
          return number === undefined
            ? fallback
            : (byNumber.get(number) ?? fallback)
        }

        return {
          ...base,
          from: resolve(response.from, from),
          to: resolve(response.to, to),
          mode,
          textSupported: resolvedTextSupport,
          outcome: {
            state: 'ok' as const,
            hunks,
            added: readCount(stats.added, added),
            removed: readCount(stats.removed, removed),
            omittedHunks,
          },
        } satisfies DiffData
      }),
    )
  })
