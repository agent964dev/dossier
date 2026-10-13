import { CliConfig, CommandDescriptor, HelpDoc, Usage } from '@effect/cli'
import type { ExitCode } from '@dossier/contracts'

import { verbs } from './commands/index.ts'
import agentVersions from './guide/agent-versions.md' with { type: 'text' }
import baseLayer from './guide/base-layer.md' with { type: 'text' }
import components from './guide/components.md' with { type: 'text' }
import embedding from './guide/embedding.md' with { type: 'text' }
import exporting from './guide/export.md' with { type: 'text' }
import forms from './guide/forms.md' with { type: 'text' }
import history from './guide/history.md' with { type: 'text' }
import kitFiles from './guide/kit-files.md' with { type: 'text' }
import layouts from './guide/layouts.md' with { type: 'text' }
import liveData from './guide/live-data.md' with { type: 'text' }
import pageClient from './guide/page-client.md' with { type: 'text' }
import reading from './guide/reading.md' with { type: 'text' }
import sharing from './guide/sharing.md' with { type: 'text' }
import themes from './guide/themes.md' with { type: 'text' }
import treeAndLinks from './guide/tree-and-links.md' with { type: 'text' }
import { VERSION } from './io.ts'
import { EXIT_MEANINGS, helpText, spanText } from './render.ts'

export interface GuideVerb {
  readonly name: string
  readonly usage: string
  readonly flags: readonly string[]
  readonly summary: string
}

export interface GuideSection {
  readonly title: string
  readonly markdown: string
}

/**
 * What an agent needs to drive the CLI: the verbs and exit codes read off the
 * command declarations, and the conventions the CLI carries as Markdown.
 */
export interface Guide {
  readonly verbs: readonly GuideVerb[]
  readonly exitCodes: Readonly<Record<ExitCode, string>>
  /** In order; the first says what Dossier is and comes before the verbs. */
  readonly conventions: readonly GuideSection[]
}

/** The conventions, in the order the guide gives them. */
const CONVENTIONS: readonly string[] = [
  treeAndLinks,
  kitFiles,
  layouts,
  themes,
  components,
  baseLayer,
  embedding,
  forms,
  pageClient,
  liveData,
  agentVersions,
  reading,
  sharing,
  exporting,
  history,
]

/** A convention file: its `## Title` line, then its Markdown. */
export const sectionOf = (text: string): GuideSection => {
  const [first = '', ...rest] = text.replace(/\r\n/g, '\n').split('\n')
  const title = /^## (.+)$/.exec(first)?.[1]?.trim()
  if (title === undefined) {
    throw new Error(`A guide section must start with "## <title>": ${first}`)
  }
  return { title, markdown: rest.join('\n').trim() }
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
  conventions: CONVENTIONS.map(sectionOf),
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
  const section = (c: GuideSection) => [`## ${c.title}`, '', c.markdown, '']
  const [about, ...rest] = g.conventions
  return [
    `# dossier ${VERSION}`,
    '',
    'The Dossier command line. Every verb takes `--json` (or ' +
      '`DOSSIER_JSON=1`) and then prints one JSON value on stdout; a failure ' +
      'prints `{ "error": { "code": <exit code>, "message", "fix", "path" } }`.',
    'To act with an agent key from settings, set both `DOSSIER_DEPLOYMENT` ' +
      'and `DOSSIER_KEY`.',
    '',
    ...(about === undefined ? [] : section(about)),
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
    ...rest.flatMap(section),
  ].join('\n')
}
