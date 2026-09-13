import type { DiffMode, DiffResponse, DiffVersion } from '@dossier/contracts'
import { Context, Data, Effect, Layer } from 'effect'
import { structuredPatch } from 'diff'
import { parse, type DefaultTreeAdapterTypes } from 'parse5'

import { Access } from './access'
import { Db } from './db'
import { WorkerEnv } from './env'
import {
  apiError,
  type DossierError,
  PersistenceError,
  StorageError,
} from './errors'
import { Objects } from './objects'
import type { PrincipalIdentity } from './principal'

const MAX_DIFF_LINES = 20_000
const MAX_DIFF_EDIT_LENGTH = 1_000
const DIFF_TIMEOUT_MS = 200

const OMITTED_TEXT_ELEMENTS = new Set(['script', 'style', 'template'])
const BLOCK_ELEMENTS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'caption',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
])

type HtmlNode = DefaultTreeAdapterTypes.Node
type HtmlElement = DefaultTreeAdapterTypes.Element

interface VersionRow {
  readonly version_number: number
  readonly object_key: string
  readonly file_size: number
  readonly created_at: string
}

export class DiffTooLarge extends Data.TaggedError('DiffTooLarge')<{
  readonly message: string
}> {}

export interface DiffService {
  readonly compare: (
    documentId: string,
    options: {
      readonly from?: number
      readonly to?: number
      readonly mode?: DiffMode
    },
    principal: PrincipalIdentity,
  ) => Effect.Effect<
    DiffResponse,
    DossierError | DiffTooLarge | PersistenceError | StorageError
  >
}

export class Diff extends Context.Tag('@dossier/web/Diff')<
  Diff,
  DiffService
>() {}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function normalizeHtml(html: string): string {
  return html.replace(/^﻿/, '').replaceAll('\r\n', '\n')
}

function isElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node
}

function nodeChildren(
  node: HtmlNode,
): readonly DefaultTreeAdapterTypes.ChildNode[] {
  return 'childNodes' in node ? node.childNodes : []
}

/** Visible text, assigned to the nearest block without recursive DOM walks. */
export function visibleText(html: string): string {
  const document = parse(normalizeHtml(html))
  const search: HtmlNode[] = [document]
  let body: HtmlElement | null = null
  while (search.length > 0) {
    const node = search.pop()!
    if (isElement(node) && node.tagName === 'body') {
      body = node
      break
    }
    const children = nodeChildren(node)
    for (let index = children.length - 1; index >= 0; index -= 1) {
      search.push(children[index]!)
    }
  }
  if (!body) return ''

  type Frame = { readonly node: HtmlNode; readonly owner: HtmlElement | null }
  const stack: Frame[] = [{ node: body, owner: null }]
  const order: HtmlElement[] = []
  const textByBlock = new Map<HtmlElement, string[]>()

  while (stack.length > 0) {
    const { node, owner } = stack.pop()!
    if ('value' in node) {
      if (owner) textByBlock.get(owner)!.push(node.value)
      continue
    }
    if (!isElement(node) || OMITTED_TEXT_ELEMENTS.has(node.tagName)) continue

    const blockOwner = BLOCK_ELEMENTS.has(node.tagName) ? node : owner
    if (blockOwner === node) {
      order.push(node)
      textByBlock.set(node, [])
    }
    if (node.tagName === 'br' && blockOwner) {
      textByBlock.get(blockOwner)!.push(' ')
    }

    const children = nodeChildren(node)
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index]!, owner: blockOwner })
    }
  }

  const lines = order.flatMap((block) => {
    const text = textByBlock.get(block)!.join('').replace(/\s+/gu, ' ').trim()
    return text === '' ? [] : [text]
  })
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

function lineCount(text: string): number {
  if (text.length === 0) return 0
  const newlines = text.match(/\n/g)?.length ?? 0
  return newlines + (text.endsWith('\n') ? 0 : 1)
}

function versionDto(row: VersionRow): DiffVersion {
  return {
    versionNumber: row.version_number,
    createdAt: row.created_at,
    fileSize: row.file_size,
  }
}

export const DiffLive = Layer.effect(
  Diff,
  Effect.gen(function* () {
    const db = yield* Db
    const objects = yield* Objects
    const access = yield* Access
    const env = yield* WorkerEnv

    const readVersion = (
      row: VersionRow,
    ): Effect.Effect<string, DossierError | StorageError> =>
      Effect.gen(function* () {
        const object = yield* objects.get(row.object_key)
        if (!object) {
          return yield* Effect.fail(
            apiError('not_found', 'Document version content not found.'),
          )
        }
        return yield* Effect.tryPromise({
          try: () => object.text(),
          catch: (cause) =>
            new StorageError({
              operation: 'read document version for diff',
              cause,
            }),
        })
      })

    const compare: DiffService['compare'] = (documentId, options, principal) =>
      Effect.gen(function* () {
        const decision = yield* access.requireEditor(documentId, principal)
        if (!decision.canRead) {
          return yield* Effect.fail(
            apiError('not_found', 'Document not found.'),
          )
        }

        const mode = options.mode ?? 'html'
        const rows = yield* Effect.tryPromise({
          try: () =>
            db.raw
              .prepare(
                `SELECT version_number, object_key, file_size, created_at
                   FROM document_versions
                  WHERE document_id = ?
                  ORDER BY version_number DESC`,
              )
              .bind(documentId)
              .all<VersionRow>(),
          catch: (cause) =>
            new PersistenceError({
              operation: 'load versions for diff',
              cause,
            }),
        })
        const latest = rows.results[0]?.version_number
        if (latest === undefined) {
          return yield* Effect.fail(
            apiError('not_found', 'Document version not found.'),
          )
        }

        const toNumber = options.to ?? latest
        const fromNumber = options.from ?? toNumber - 1
        const byNumber = new Map(
          rows.results.map((row) => [row.version_number, row] as const),
        )
        const fromRow = byNumber.get(fromNumber)
        const toRow = byNumber.get(toNumber)
        if (!fromRow || !toRow) {
          return yield* Effect.fail(
            apiError('not_found', 'Document version not found.'),
          )
        }

        const maxHtmlBytes = positiveInteger(
          env.MAX_HTML_BYTES,
          'MAX_HTML_BYTES',
        )
        if (
          fromRow.file_size > maxHtmlBytes ||
          toRow.file_size > maxHtmlBytes
        ) {
          return yield* Effect.fail(
            new DiffTooLarge({
              message: `Diff input exceeds the ${maxHtmlBytes} byte per-version limit.`,
            }),
          )
        }

        const fromSource = yield* readVersion(fromRow)
        const toSource =
          fromNumber === toNumber ? fromSource : yield* readVersion(toRow)
        const fromText =
          mode === 'text' ? visibleText(fromSource) : normalizeHtml(fromSource)
        const toText =
          mode === 'text' ? visibleText(toSource) : normalizeHtml(toSource)
        const totalLines = lineCount(fromText) + lineCount(toText)
        if (totalLines > MAX_DIFF_LINES) {
          return yield* Effect.fail(
            new DiffTooLarge({
              message: `Diff input has ${totalLines} lines; maximum is ${MAX_DIFF_LINES}.`,
            }),
          )
        }

        const patch = structuredPatch(
          `${documentId}@${fromNumber}`,
          `${documentId}@${toNumber}`,
          fromText,
          toText,
          undefined,
          undefined,
          {
            context: 3,
            // Workers may freeze Date.now() during synchronous execution, so
            // maxEditLength is the authoritative CPU bound; timeout is an
            // additional guard in runtimes whose clock advances.
            timeout: DIFF_TIMEOUT_MS,
            maxEditLength: MAX_DIFF_EDIT_LENGTH,
          },
        )
        if (!patch) {
          return yield* Effect.fail(
            new DiffTooLarge({
              message:
                'These versions are too different to compare within the server limit.',
            }),
          )
        }

        let added = 0
        let removed = 0
        const hunks = patch.hunks.map((hunk) => {
          const lines: Array<{
            op: ' ' | '+' | '-'
            text: string
            noNewline?: boolean
          }> = []
          for (const line of hunk.lines) {
            if (line === '\\ No newline at end of file') {
              const previous = lines.at(-1)
              if (previous) previous.noNewline = true
              continue
            }
            const op = line[0]
            if (op !== ' ' && op !== '+' && op !== '-') continue
            if (op === '+') added += 1
            else if (op === '-') removed += 1
            lines.push({ op, text: line.slice(1) })
          }
          return {
            oldStart: hunk.oldStart,
            oldLines: hunk.oldLines,
            newStart: hunk.newStart,
            newLines: hunk.newLines,
            lines,
          }
        })

        return {
          ok: true,
          documentId,
          from: versionDto(fromRow),
          to: versionDto(toRow),
          mode,
          hunks,
          stats: { added, removed },
        }
      })

    return { compare }
  }),
)
