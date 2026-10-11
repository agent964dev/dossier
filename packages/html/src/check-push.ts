import type { FormSummary, HtmlAnalysis } from './analyze.ts'
import { closingTime, resolveFormAction } from './forms.ts'
import { MAX_DEPTH, isKitName, isNodeName, isPageFile } from './paths.ts'
import { decodeSegment, trimUrl } from './urls.ts'

/** The tree as it will be after the push. */
export interface TreeView {
  readonly kindAt: (path: string) => 'page' | 'file' | 'folder' | 'data' | null
}
/** Every HTML file the push writes, with its path inside the tree. */
export interface PushFile {
  readonly path: string
  readonly analysis: HtmlAnalysis
}
export type PushProblemCode =
  /** a/b.html and a/b/index.html both present. */
  | 'page_folder_clash'
  /** <base> in a page or layout. */
  | 'base_element'
  /** A form without action. */
  | 'form_without_action'
  /** The action resolves above the tree root, to another host or root-relative. */
  | 'form_action_outside'
  /** The action names an authored file, a `_` path or a page. */
  | 'form_action_authored'
  /** The action is neither a folder ending in '/' nor a .json file. */
  | 'form_action_kind'
  /** data-closes has no offset or Z. */
  | 'closes_without_offset'
  /** Two forms on one page share a target and lack distinct ids. */
  | 'forms_need_ids'
  /** Deeper than MAX_DEPTH. */
  | 'too_deep'
  /** A segment isNodeName refuses. */
  | 'bad_name'
export interface PushProblem {
  readonly code: PushProblemCode
  readonly path: string
  readonly line: number | null
  readonly message: string
  readonly fix: string
}
export interface PushWarning {
  readonly code: string
  readonly path: string
  readonly line: number | null
  readonly message: string
}
export interface PushCheck {
  readonly problems: readonly PushProblem[]
  readonly warnings: readonly PushWarning[]
}

type Problem = PushProblem

const problem = (
  code: PushProblemCode,
  path: string,
  line: number | null,
  message: string,
  fix: string,
): Problem => ({ code, path, line, message, fix })

const listLines = (lines: readonly number[]): string =>
  lines.length === 1
    ? `${lines[0]}`
    : `${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]}`

const KIND_FIX =
  'Point action at a folder ending in / for one file per person, such as action="answers/", or at a .json file for one shared file, such as action="answers.json".'

/** Why an action that resolves outside the tree does. */
const outsideReason = (action: string): string => {
  const url = trimUrl(action)
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || /^[\\/]{2}/.test(url)) {
    return 'which sends answers to another site'
  }
  if (url.startsWith('/') || url.startsWith('\\')) {
    return 'which starts at the top of the site rather than beside the page'
  }
  if (url.startsWith('?') || url.startsWith('#')) {
    return 'which points back at the page itself'
  }
  return 'which climbs above the top of this tree'
}

const AUTHORED_FIX =
  'Point action at a new folder or .json file that holds only answers, such as action="answers/".'

/** The action, or the page's own folder, passes through a `_` name. */
const namesKit = (path: string, action: string): boolean =>
  [...path.split('/').slice(0, -1), ...trimUrl(action).split(/[\\/]/)]
    .map(decodeSegment)
    .some(isKitName)

/** What a form's target names when the push refuses it as authored. */
const authoredWhat = (
  target: string,
  kind: 'page' | 'file' | 'folder',
): string => {
  if (kind === 'page') return `${target}, a page`
  if (kind === 'folder') return `${target}, a folder of pushed files`
  return `${target}, a file the push writes`
}

const formProblems = (
  path: string,
  form: FormSummary,
  tree: TreeView,
): {
  readonly problems: readonly Problem[]
  readonly target: string | null
} => {
  const found: Problem[] = []
  const where = `${path}: the form on line ${form.line}`
  let target: string | null = null
  const action = form.action === null ? '' : form.action.trim()

  if (action === '') {
    found.push(
      problem(
        'form_without_action',
        path,
        form.line,
        `${where} has no action.`,
        'Add action="decisions/" for one file per person, or action="decisions.json" for one shared file.',
      ),
    )
  } else {
    const resolved = resolveFormAction(path, action)
    const written = `action="${action}"`
    if ('problem' in resolved) {
      switch (resolved.problem) {
        case 'form_action_outside':
          found.push(
            problem(
              'form_action_outside',
              path,
              form.line,
              `${where} has ${written}, ${outsideReason(action)}.`,
              'Point action at a folder or .json file inside this tree, written relative to the page, such as action="answers/".',
            ),
          )
          break
        case 'form_action_authored':
          found.push(
            problem(
              'form_action_authored',
              path,
              form.line,
              `${where} has ${written}, which names ${namesKit(path, action) ? 'a _ file or folder that only a push may change' : 'the top of this tree, which holds pushed files'}.`,
              AUTHORED_FIX,
            ),
          )
          break
        case 'bad_name':
          found.push(
            problem(
              'bad_name',
              path,
              form.line,
              `${where} has ${written}, which holds a name no file or folder can have.`,
              'Use plain names in action, without control characters or encoded slashes.',
            ),
          )
          break
        default:
          found.push(
            problem(
              'form_action_kind',
              path,
              form.line,
              `${where} has ${written}, which is neither a folder ending in / nor a .json file.`,
              KIND_FIX,
            ),
          )
      }
    } else {
      const kind = tree.kindAt(resolved.target)
      if (kind === 'page' || kind === 'file' || kind === 'folder') {
        found.push(
          problem(
            'form_action_authored',
            path,
            form.line,
            `${where} has ${written}, which names ${authoredWhat(resolved.target, kind)}.`,
            AUTHORED_FIX,
          ),
        )
      } else {
        target =
          resolved.kind === 'folder' ? `${resolved.target}/` : resolved.target
      }
    }
  }

  if (form.closes !== null) {
    const time = closingTime(form.closes)
    if (typeof time !== 'number') {
      found.push(
        problem(
          'closes_without_offset',
          path,
          form.line,
          time === 'no_offset'
            ? `${where} has data-closes="${form.closes}", which has no time zone.`
            : `${where} has data-closes="${form.closes}", which is not a date and time with a time zone.`,
          'Write the closing time with Z for UTC or an offset, such as data-closes="2026-10-20T18:00+03:00".',
        ),
      )
    }
  }
  return { problems: found, target }
}

/**
 * Every problem that stops a push, one HTML file at a time: the file's path,
 * a <base> element, each form's action and closing time, two forms with one
 * target and no ids to tell them apart, and a page that clashes with a
 * folder's index page.
 */
export const checkPush = (
  files: readonly PushFile[],
  tree: TreeView,
): PushCheck => {
  const problems: Problem[] = []
  const clashes = new Set<string>()

  for (const { path, analysis } of files) {
    problems.push(...pathProblems(path))

    if (analysis.base !== null) {
      problems.push(
        problem(
          'base_element',
          path,
          analysis.baseLine,
          `${path}: the <base> element${analysis.baseLine === null ? '' : ` on line ${analysis.baseLine}`} changes where every relative link in the page points, so Dossier does not allow it.`,
          'Remove the <base> element and write links relative to the file.',
        ),
      )
    }

    const byTarget = new Map<string, FormSummary[]>()
    for (const form of analysis.forms) {
      const checked = formProblems(path, form, tree)
      problems.push(...checked.problems)
      if (checked.target !== null) {
        const same = byTarget.get(checked.target) ?? []
        same.push(form)
        byTarget.set(checked.target, same)
      }
    }
    for (const [target, forms] of byTarget) {
      if (forms.length < 2) continue
      const ids = forms.map((form) => form.id)
      const distinct =
        ids.every((id) => id !== null && id !== '') &&
        new Set(ids).size === ids.length
      if (distinct) continue
      const lines = forms.map((form) => form.line)
      problems.push(
        problem(
          'forms_need_ids',
          path,
          lines[1] ?? null,
          `${path}: the forms on lines ${listLines(lines)} all send to ${target} without ids that tell them apart.`,
          'Give each of these forms its own id, such as id="morning" and id="evening".',
        ),
      )
    }

    const clash = clashOf(path, tree)
    if (clash !== null && !clashes.has(clash.page)) {
      clashes.add(clash.page)
      problems.push(
        problem(
          'page_folder_clash',
          path,
          null,
          `${path}: ${clash.file} and ${clash.index} would both be the page ${clash.page}.`,
          `Keep one of them: remove ${clash.file}, or remove ${clash.index}.`,
        ),
      )
    }
  }
  return { problems, warnings: [] }
}

/** `a/b.html` against `a/b/index.html`, either way round. */
const clashOf = (
  path: string,
  tree: TreeView,
): {
  readonly page: string
  readonly file: string
  readonly index: string
} | null => {
  if (!isPageFile(path) || path.split('/').some(isKitName)) return null
  if (path === 'index.html') return null
  if (path.endsWith('/index.html')) {
    const page = path.slice(0, -'/index.html'.length)
    const file = `${page}.html`
    return tree.kindAt(file) === 'page' ? { page, file, index: path } : null
  }
  const page = path.slice(0, -'.html'.length)
  const index = `${page}/index.html`
  return tree.kindAt(index) === 'page' ? { page, file: path, index } : null
}

const encoder = new TextEncoder()

/** The problems of one path's names and depth, for every file a push holds. */
export const pathProblems = (path: string): readonly PushProblem[] => {
  const found: Problem[] = []
  const segments = path.split('/')
  const seen = new Set<string>()
  for (const segment of segments) {
    if (isNodeName(segment) || seen.has(segment)) continue
    seen.add(segment)
    if (segment === '') {
      found.push(
        problem(
          'bad_name',
          path,
          null,
          `${path}: the path has an empty name, from a slash at its start or end or two slashes in a row.`,
          'Remove the extra slash.',
        ),
      )
    } else if (segment === '.' || segment === '..') {
      found.push(
        problem(
          'bad_name',
          path,
          null,
          `${path}: "${segment}" cannot be the name of a file or folder.`,
          'Give the file or folder a real name.',
        ),
      )
    } else if (encoder.encode(segment).length > 255) {
      found.push(
        problem(
          'bad_name',
          path,
          null,
          `${path}: the name "${[...segment].slice(0, 40).join('')}…" is longer than 255 bytes.`,
          'Shorten the name to 255 bytes or fewer.',
        ),
      )
    } else {
      found.push(
        problem(
          'bad_name',
          path,
          null,
          `${path}: the name ${JSON.stringify(segment)} holds a control character, such as a tab or a line break.`,
          'Rename it without control characters.',
        ),
      )
    }
  }
  if (segments.length > MAX_DEPTH) {
    found.push(
      problem(
        'too_deep',
        path,
        null,
        `${path}: the file sits ${segments.length} levels deep, and a tree holds files at most ${MAX_DEPTH} levels deep.`,
        'Move it into a folder nearer the top of the tree.',
      ),
    )
  }
  return found
}

/**
 * Problems as one error: a single problem keeps its message, fix and path;
 * several are listed one per line.
 */
export const describeProblems = (
  problems: readonly PushProblem[],
): {
  readonly message: string
  readonly fix: string
  readonly path: string | null
} => {
  const [first] = problems
  if (first === undefined) return { message: '', fix: '', path: null }
  if (problems.length === 1) {
    return { message: first.message, fix: first.fix, path: first.path }
  }
  return {
    message: [
      `This push has ${problems.length} problems:`,
      ...problems.map((each) => `- ${each.message} ${each.fix}`),
    ].join('\n'),
    fix: 'Fix each file above, then push again.',
    path: first.path,
  }
}
