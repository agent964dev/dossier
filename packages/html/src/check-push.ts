import type { FormSummary, HtmlAnalysis } from './analyze.ts'
import { closingTime, resolveFormAction } from './forms.ts'
import {
  MAX_DEPTH,
  isKitName,
  isNodeName,
  isPageFile,
  parentOf,
} from './paths.ts'
import { decodeSegment, resolveFrom, trimUrl } from './urls.ts'

/** The tree as it will be after the push. */
export interface TreeView {
  readonly kindAt: (path: string) => 'page' | 'file' | 'folder' | 'data' | null
  /**
   * A live `_components/<tag>.js` at the folder or above, or a base
   * component of that tag.
   */
  readonly componentAt: (folder: string, tag: string) => boolean
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
  /** The action is a page's comments folder or lies inside one. */
  | 'form_action_comments'
  /** data-closes has no offset or Z. */
  | 'closes_without_offset'
  /** A JSON field marked required, or whose value is not a JSON object. */
  | 'json_field'
  /** Two forms on one page share a target and lack distinct ids. */
  | 'forms_need_ids'
  /** Deeper than MAX_DEPTH. */
  | 'too_deep'
  /** An authored file inside a page's comments folder, which holds only comments. */
  | 'comments_folder'
  /** A segment isNodeName refuses. */
  | 'bad_name'
export interface PushProblem {
  readonly code: PushProblemCode
  readonly path: string
  readonly line: number | null
  readonly message: string
  readonly fix: string
}
export type PushWarningCode =
  /** A page or layout uses a tag no component file above it defines. */
  | 'component_missing'
  /** parse5 had to repair a layout's structure. */
  | 'layout_repaired'
  /** A layout without a <slot>: pages below go at the end of its body. */
  | 'layout_without_slot'
  /** A page's <link rel="alternate"> names a file the tree does not hold. */
  | 'companion_missing'
export interface PushWarning {
  readonly code: PushWarningCode
  readonly path: string
  readonly line: number | null
  readonly message: string
}
export interface CheckOptions {
  /** The paths the push adds or changes; warnings name only these. */
  readonly warnFor: ReadonlySet<string>
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
      if (
        resolved.target.split('/').some((name) => name.endsWith('.comments'))
      ) {
        found.push(
          problem(
            'form_action_comments',
            path,
            form.line,
            `${where} has ${written}, which is inside a page's comments folder, where everyone who reads the page reads what is written.`,
            'Point the form at a folder or .json file of its own, such as action="answers/".',
          ),
        )
      } else if (kind === 'page' || kind === 'file' || kind === 'folder') {
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
  for (const field of form.fields) {
    if (field.type !== 'json') continue
    const named = `${where} has the JSON field ${field.name}`
    if (field.required) {
      found.push(
        problem(
          'json_field',
          path,
          form.line,
          `${named} marked required, which a JSON field cannot be: page code fills it.`,
          'Remove required from the JSON field.',
        ),
      )
    }
    if (!isJsonObjectText(field.value ?? '')) {
      found.push(
        problem(
          'json_field',
          path,
          form.line,
          `${named}, whose value is not a JSON object.`,
          'Leave value out, or write a JSON object in it, such as value="{}".',
        ),
      )
    }
  }
  return { problems: found, target }
}

/** Empty, or the text of a JSON object: what a JSON field may start with. */
const isJsonObjectText = (text: string): boolean => {
  if (text.trim() === '') return true
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  } catch {
    return false
  }
}

/**
 * The tree path a page's <link rel="alternate"> names as its companion, or
 * null when it names none or points outside the tree. Layouts and other `_`
 * files have no agent version.
 */
export const companionOf = (
  path: string,
  analysis: HtmlAnalysis,
): string | null => namedCompanion(path, analysis.alternate)

/** companionOf, from the alternate's href as the analysis holds it. */
export const namedCompanion = (
  path: string,
  alternate: string | null,
): string | null => {
  if (alternate === null) return null
  if (path.split('/').some(isKitName)) return null
  const target = resolveFrom(parentOf(path), alternate)
  return target === null || target === '' || target.endsWith('/')
    ? null
    : target
}

const hasFile = (tree: TreeView, path: string): boolean => {
  const kind = tree.kindAt(path)
  return kind === 'file' || kind === 'page' || kind === 'data'
}

const isLayoutFile = (path: string): boolean =>
  path === '_layout.html' || path.endsWith('/_layout.html')

/** A page outside every `_` folder, or a layout. */
const usesComponents = (path: string): boolean =>
  isLayoutFile(path) ||
  !path
    .split('/')
    .slice(0, -1)
    .some((segment) => isKitName(segment))

/**
 * What a push warns about and still commits: a tag with no component file
 * above the page or layout that uses it, and a layout parse5 had to repair
 * or that has no slot.
 */
const warningsOf = (
  path: string,
  analysis: HtmlAnalysis,
  tree: TreeView,
): PushWarning[] => {
  const found: PushWarning[] = []
  const folder = parentOf(path)
  if (usesComponents(path)) {
    for (const tag of analysis.tags) {
      if (tree.componentAt(folder, tag)) continue
      found.push({
        code: 'component_missing',
        path,
        line: null,
        message: `${path} uses <${tag}>, but no _components/${tag}.js is above it.`,
      })
    }
  }
  const companion = companionOf(path, analysis)
  if (companion !== null && !hasFile(tree, companion)) {
    found.push({
      code: 'companion_missing',
      path,
      line: null,
      message: `${path} names ${companion} as its agent version, but ${companion} is not in the tree.`,
    })
  }
  if (isLayoutFile(path)) {
    for (const repair of analysis.repaired) {
      found.push({
        code: 'layout_repaired',
        path,
        line: repair.line,
        message: `${path}: ${repair.message}.`,
      })
    }
    if (analysis.slot === null) {
      found.push({
        code: 'layout_without_slot',
        path,
        line: null,
        message: `${path} has no <slot>, so pages below it go at the end of its <body>.`,
      })
    }
  }
  return found
}

/**
 * Every problem that stops a push, one HTML file at a time: the file's path,
 * a <base> element, each form's action and closing time, two forms with one
 * target and no ids to tell them apart, and a page that clashes with a
 * folder's index page. Then the warnings, for the files in `warnFor` (every
 * file without options).
 */
export const checkPush = (
  files: readonly PushFile[],
  tree: TreeView,
  options?: CheckOptions,
): PushCheck => {
  const problems: Problem[] = []
  const warnings: PushWarning[] = []
  const clashes = new Set<string>()

  for (const { path, analysis } of files) {
    if (options === undefined || options.warnFor.has(path)) {
      warnings.push(...warningsOf(path, analysis, tree))
    }
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

    const clash = pageFolderClash(path, (at) => tree.kindAt(at) === 'page')
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
  return { problems, warnings }
}

/**
 * `a/b.html` against `a/b/index.html`, either way round: the page both
 * would be, when `isPage` says the other one is there too.
 */
export const pageFolderClash = (
  path: string,
  isPage: (path: string) => boolean,
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
    return isPage(file) ? { page, file, index: path } : null
  }
  const page = path.slice(0, -'.html'.length)
  const index = `${page}/index.html`
  return isPage(index) ? { page, file: path, index } : null
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
  const comments = segments.findIndex(
    (segment, n) =>
      n < segments.length - 1 &&
      segment.endsWith('.comments') &&
      segment !== '.comments',
  )
  if (comments >= 0) {
    const folder = segments.slice(0, comments + 1).join('/')
    found.push(
      problem(
        'comments_folder',
        path,
        null,
        `${path} is inside ${folder}/, a page's comments folder, which holds only the comments people write.`,
        `Move it out of ${folder}/.`,
      ),
    )
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
