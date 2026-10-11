import { CliConfig, CommandDescriptor, HelpDoc, Usage } from '@effect/cli'
import type { ExitCode } from '@dossier/contracts'

import { verbs } from './commands/index.ts'
import { VERSION } from './io.ts'
import { EXIT_MEANINGS, helpText, spanText } from './render.ts'

export interface GuideVerb {
  readonly name: string
  readonly usage: string
  readonly flags: readonly string[]
  readonly summary: string
}

/** What an agent needs to drive the CLI, read off the command declarations. */
export interface Guide {
  readonly verbs: readonly GuideVerb[]
  readonly exitCodes: Readonly<Record<ExitCode, string>>
}

const blocks = (doc: HelpDoc.HelpDoc): HelpDoc.HelpDoc[] => {
  switch (doc._tag) {
    case 'Empty':
      return []
    case 'Sequence':
      return [...blocks(doc.left), ...blocks(doc.right)]
    default:
      return [doc]
  }
}

/** A command's help, split under its headers (DESCRIPTION, OPTIONS, …). */
const sections = (doc: HelpDoc.HelpDoc): Map<string, HelpDoc.HelpDoc[]> => {
  const result = new Map<string, HelpDoc.HelpDoc[]>()
  let current: HelpDoc.HelpDoc[] = []
  for (const block of blocks(doc)) {
    if (block._tag === 'Header') {
      current = []
      result.set(spanText(block.value), current)
    } else {
      current.push(block)
    }
  }
  return result
}

/** Each verb's own flags; --help and the other built-ins are left out. */
const verbHelp = CliConfig.make({ showBuiltIns: false })

const describeVerb = (verb: CommandDescriptor.Command<unknown>): GuideVerb => {
  const help = sections(CommandDescriptor.getHelp(verb, verbHelp))
  const summary = (help.get('DESCRIPTION') ?? []).map(helpText).join(' ')
  const flags = (help.get('OPTIONS') ?? []).flatMap((block) =>
    block._tag === 'DescriptionList'
      ? block.definitions.map(([term]) => spanText(term))
      : [],
  )
  const usage = spanText(
    HelpDoc.getSpan(Usage.getHelp(CommandDescriptor.getUsage(verb))),
  )
  const [name = usage.split(' ')[0] ?? ''] = CommandDescriptor.getNames(verb)
  return { name, usage: `dossier ${usage}`, flags, summary }
}

/** The guide, generated from the verbs' declarations so it cannot drift. */
export const guide = (): Guide => ({
  verbs: verbs.map((verb) => describeVerb(verb.descriptor)),
  exitCodes: EXIT_MEANINGS,
})

/** The guide as Markdown, for `dossier --agent-info`. */
export const guideMarkdown = (g: Guide): string => {
  const verbSections = g.verbs.map((verb) =>
    [
      `### ${verb.name}`,
      '',
      verb.summary,
      '',
      '```sh',
      verb.usage,
      '```',
      ...(verb.flags.length === 0
        ? []
        : ['', `Flags: ${verb.flags.map((flag) => `\`${flag}\``).join(', ')}`]),
    ].join('\n'),
  )
  const exitRows = Object.entries(g.exitCodes).map(
    ([code, meaning]) => `| ${code} | ${meaning} |`,
  )
  return [
    `# dossier ${VERSION}`,
    '',
    'The Dossier command line. Every verb takes `--json` (or ' +
      '`DOSSIER_JSON=1`) and then prints one JSON value on stdout; a failure ' +
      'prints `{ "error": { "code": <exit code>, "message", "fix", "path" } }`.',
    'To act with an agent key from settings, set both `DOSSIER_DEPLOYMENT` ' +
      'and `DOSSIER_KEY`.',
    '',
    '## Verbs',
    '',
    verbSections.join('\n\n'),
    '',
    '## Exit codes',
    '',
    '| Code | Meaning |',
    '| --- | --- |',
    ...exitRows,
    '',
  ].join('\n')
}
