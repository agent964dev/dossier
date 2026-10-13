import { Args, Command } from '@effect/cli'
import {
  DossierError,
  dossierError,
  type LinkRef,
  type ReadResult,
} from '@dossier/contracts'
import { Effect } from 'effect'

import { callApi } from '../client.ts'
import { Cli } from '../io.ts'
import { jsonOption } from '../render.ts'
import { targetString } from '../sync.ts'
import { resolveTarget } from '../target.ts'

/** '512 bytes', '2.1 MB': decimal units, as the deployment writes them. */
export const sizeText = (bytes: number): string => {
  if (bytes < 1000) return bytes === 1 ? '1 byte' : `${bytes} bytes`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** 'a PDF', 'an SVG', 'a file': spelled-out letters take 'an' before a vowel sound. */
const kindOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return 'a file'
  const ext = name.slice(dot + 1).toUpperCase()
  const letters = ext.length <= 4 && /^[A-Z0-9]+$/.test(ext) && ext !== 'JSON'
  const an = letters ? /^[AEFHILMNORSX8]/.test(ext) : /^[AEIOU]/.test(ext)
  return `${an ? 'an' : 'a'} ${ext}`
}

/** What `dossier read` prints: the text the link returns, or how to get a file. */
export const describeRead = (result: ReadResult): string => {
  if (result.kind !== 'file' || result.text !== null) return result.text ?? ''
  const name = result.path.slice(result.path.lastIndexOf('/') + 1)
  return `${name} is ${kindOf(name)}, ${sizeText(result.size)}. Download it with dossier pull.`
}

/**
 * The path the read endpoint takes, and how a refusal names what was asked.
 * A folder keeps its trailing slash: `open/` names the folder even when
 * `open.html` exists beside it.
 */
export const readPath = (ref: LinkRef): string =>
  ref.folder && ref.path !== '' ? `${targetString(ref)}/` : targetString(ref)

/**
 * A read that finds nothing, worded the same whether nothing is there or the
 * key cannot read it. A path that may name a folder also says that a form's
 * folder does not exist before its first answer.
 */
export const notFoundMessage = (ref: LinkRef): string => {
  const last = ref.path.slice(ref.path.lastIndexOf('/') + 1)
  const mayBeFolder = ref.path !== '' && (ref.folder || !last.includes('.'))
  return (
    `Nothing at ${readPath(ref)}, or you cannot read it.` +
    (mayBeFolder
      ? ' A folder a form writes to appears with its first answer.'
      : '')
  )
}

export const read = Command.make(
  'read',
  {
    target: Args.text({ name: 'target' }).pipe(
      Args.withDescription(
        'What to read: workspace/tree/path, workspace/tree/folder/, or a link.',
      ),
    ),
    json: jsonOption,
  },
  ({ target }) =>
    Effect.gen(function* () {
      const { output } = yield* Cli
      const { remote, ref } = yield* resolveTarget(target)
      const result = yield* callApi(remote.deployment, remote.key, (client) =>
        client.read.read({ urlParams: { path: readPath(ref) } }),
      ).pipe(
        Effect.catchIf(
          (error) =>
            error instanceof DossierError && error.code === 'not_found',
          (error) =>
            Effect.fail(
              dossierError(
                'not_found',
                notFoundMessage(ref),
                (error as DossierError).fix,
                (error as DossierError).path,
              ),
            ),
        ),
      )
      // What the link returns, byte for byte; only Dossier's own sentence
      // about a file it cannot print gets a newline.
      if (result.text !== null) output.exact(result.text, result)
      else output.result(describeRead(result), result)
    }),
).pipe(
  Command.withDescription(
    "Print what a link gives an agent: a page's agent version (its companion, " +
      'or Markdown made from the page, ending with where its data and ' +
      'comments are), a folder with the kit for write holders, or a data ' +
      "folder's files with who wrote each and when.",
  ),
)
