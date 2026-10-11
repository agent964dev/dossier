import { describe, expect, it } from 'vitest'
import {
  type PushFile,
  type PushProblem,
  type PushProblemCode,
  type TreeView,
  analyze,
  checkPush,
  describeProblems,
  pathProblems,
} from '../src/index.ts'
import { fixture } from './helpers.ts'

type Kind = ReturnType<TreeView['kindAt']>

const treeOf = (kinds: Record<string, Kind> = {}): TreeView => ({
  kindAt: (path) => kinds[path] ?? null,
})

const file = (path: string, source: string): PushFile => ({
  path,
  analysis: analyze(source),
})

const codes = (problems: readonly PushProblem[]): readonly PushProblemCode[] =>
  problems.map((problem) => problem.code)

/** A page with its form on line 12, as the product's own example has it. */
const formOnLine12 = (form: string): string =>
  `${'<p>.</p>\n'.repeat(11)}${form}`

describe('checkPush', () => {
  it('passes a clean push with no warnings', () => {
    const check = checkPush(
      [
        file('plan.html', fixture('complete.html')),
        file('team/_layout.html', fixture('layout.html')),
        file(
          'team/vote.html',
          '<form action="votes.json" data-closes="2026-10-20T18:00Z"></form>',
        ),
      ],
      treeOf({ 'team/votes.json': 'data' }),
    )
    expect(check).toEqual({ problems: [], warnings: [] })
  })

  it('refuses a form without action, in the words the product uses', () => {
    const check = checkPush(
      [file('plan.html', formOnLine12('<form><input name="a"></form>'))],
      treeOf(),
    )
    expect(check.problems).toEqual([
      {
        code: 'form_without_action',
        path: 'plan.html',
        line: 12,
        message: 'plan.html: the form on line 12 has no action.',
        fix: 'Add action="decisions/" for one file per person, or action="decisions.json" for one shared file.',
      },
    ])
  })

  it('refuses an empty action the same way', () => {
    const check = checkPush(
      [file('team/hiring.html', formOnLine12('<form action=" "></form>'))],
      treeOf(),
    )
    expect(check.problems).toEqual([
      {
        code: 'form_without_action',
        path: 'team/hiring.html',
        line: 12,
        message: 'team/hiring.html: the form on line 12 has no action.',
        fix: 'Add action="decisions/" for one file per person, or action="decisions.json" for one shared file.',
      },
    ])
  })

  it('checks every form in the forms fixture', () => {
    const check = checkPush(
      [file('forms.html', fixture('forms.html'))],
      treeOf(),
    )
    expect(
      check.problems.map((problem) => [problem.code, problem.line]),
    ).toEqual([
      ['form_without_action', 8],
      ['form_without_action', 11],
    ])
  })

  it('refuses an action outside the tree', () => {
    const check = checkPush(
      [
        file(
          'plan.html',
          '<form action="https://example.com/a/"></form>\n' +
            '<form action="/answers/"></form>\n' +
            '<form action="#here"></form>\n' +
            '<form action="../answers/"></form>',
        ),
      ],
      treeOf(),
    )
    expect(check.problems.map((problem) => problem.message)).toEqual([
      'plan.html: the form on line 1 has action="https://example.com/a/", which sends answers to another site.',
      'plan.html: the form on line 2 has action="/answers/", which starts at the top of the site rather than beside the page.',
      'plan.html: the form on line 3 has action="#here", which points back at the page itself.',
      'plan.html: the form on line 4 has action="../answers/", which climbs above the top of this tree.',
    ])
    expect(new Set(codes(check.problems))).toEqual(
      new Set(['form_action_outside']),
    )
    expect(check.problems[0]?.fix).toBe(
      'Point action at a folder or .json file inside this tree, written relative to the page, such as action="answers/".',
    )
  })

  it('refuses an action onto a page, a pushed file or folder, or a `_` path', () => {
    const check = checkPush(
      [
        file(
          'team/plan.html',
          '<form action="../index.html/"></form>\n' +
            '<form action="notes.json"></form>\n' +
            '<form action="docs/"></form>\n' +
            '<form action="_kit/"></form>\n' +
            '<form action="answers/"></form>',
        ),
      ],
      treeOf({
        'index.html': 'page',
        'team/notes.json': 'file',
        'team/docs': 'folder',
        'team/answers': 'data',
      }),
    )
    expect(
      check.problems.map((problem) => [problem.code, problem.message]),
    ).toEqual([
      [
        'form_action_authored',
        'team/plan.html: the form on line 1 has action="../index.html/", which names index.html, a page.',
      ],
      [
        'form_action_authored',
        'team/plan.html: the form on line 2 has action="notes.json", which names team/notes.json, a file the push writes.',
      ],
      [
        'form_action_authored',
        'team/plan.html: the form on line 3 has action="docs/", which names team/docs, a folder of pushed files.',
      ],
      [
        'form_action_authored',
        'team/plan.html: the form on line 4 has action="_kit/", which names a _ file or folder that only a push may change.',
      ],
    ])
    expect(check.problems[0]?.fix).toBe(
      'Point action at a new folder or .json file that holds only answers, such as action="answers/".',
    )
  })

  it('refuses an action that is neither a folder nor a .json file', () => {
    const check = checkPush(
      [file('plan.html', '<form action="answers"></form>')],
      treeOf(),
    )
    expect(check.problems).toEqual([
      {
        code: 'form_action_kind',
        path: 'plan.html',
        line: 1,
        message:
          'plan.html: the form on line 1 has action="answers", which is neither a folder ending in / nor a .json file.',
        fix: 'Point action at a folder ending in / for one file per person, such as action="answers/", or at a .json file for one shared file, such as action="answers.json".',
      },
    ])
  })

  it('refuses a closing time without a time zone', () => {
    const check = checkPush(
      [
        file(
          'plan.html',
          '<form action="a/" data-closes="2026-10-20T18:00"></form>\n' +
            '<form action="b/" data-closes="Friday"></form>\n' +
            '<form action="c/" data-closes="2026-10-20T18:00+0300"></form>',
        ),
      ],
      treeOf(),
    )
    expect(check.problems).toEqual([
      {
        code: 'closes_without_offset',
        path: 'plan.html',
        line: 1,
        message:
          'plan.html: the form on line 1 has data-closes="2026-10-20T18:00", which has no time zone.',
        fix: 'Write the closing time with Z for UTC or an offset, such as data-closes="2026-10-20T18:00+03:00".',
      },
      {
        code: 'closes_without_offset',
        path: 'plan.html',
        line: 2,
        message:
          'plan.html: the form on line 2 has data-closes="Friday", which is not a date and time with a time zone.',
        fix: 'Write the closing time with Z for UTC or an offset, such as data-closes="2026-10-20T18:00+03:00".',
      },
    ])
  })

  it('needs distinct ids on forms that share a target', () => {
    const check = checkPush(
      [
        file(
          'plan.html',
          '<form action="answers/"></form>\n' +
            '<form action="./answers/"></form>\n' +
            '<form action="votes.json" id="a"></form>\n' +
            '<form action="votes.json" id="a"></form>\n' +
            '<form action="ideas/" id="am" data-entries="many"></form>\n' +
            '<form action="ideas/" id="pm" data-entries="many"></form>',
        ),
      ],
      treeOf(),
    )
    expect(check.problems).toEqual([
      {
        code: 'forms_need_ids',
        path: 'plan.html',
        line: 2,
        message:
          'plan.html: the forms on lines 1 and 2 all send to answers/ without ids that tell them apart.',
        fix: 'Give each of these forms its own id, such as id="morning" and id="evening".',
      },
      {
        code: 'forms_need_ids',
        path: 'plan.html',
        line: 4,
        message:
          'plan.html: the forms on lines 3 and 4 all send to votes.json without ids that tell them apart.',
        fix: 'Give each of these forms its own id, such as id="morning" and id="evening".',
      },
    ])
  })

  it('refuses a <base> element', () => {
    const check = checkPush(
      [file('_layout.html', fixture('base.html'))],
      treeOf(),
    )
    expect(check.problems).toEqual([
      {
        code: 'base_element',
        path: '_layout.html',
        line: 4,
        message:
          '_layout.html: the <base> element on line 4 changes where every relative link in the page points, so Dossier does not allow it.',
        fix: 'Remove the <base> element and write links relative to the file.',
      },
    ])
  })

  it('refuses a page beside a folder with its own index page, once', () => {
    const tree = treeOf({ 'a/b.html': 'page', 'a/b/index.html': 'page' })
    const both = checkPush(
      [file('a/b.html', '<p>x</p>'), file('a/b/index.html', '<p>y</p>')],
      tree,
    )
    expect(both.problems).toEqual([
      {
        code: 'page_folder_clash',
        path: 'a/b.html',
        line: null,
        message:
          'a/b.html: a/b.html and a/b/index.html would both be the page a/b.',
        fix: 'Keep one of them: remove a/b.html, or remove a/b/index.html.',
      },
    ])
    const index = checkPush([file('a/b/index.html', '<p>y</p>')], tree)
    expect(
      index.problems.map((problem) => [problem.code, problem.path]),
    ).toEqual([['page_folder_clash', 'a/b/index.html']])
    expect(checkPush([file('a/c.html', '<p>x</p>')], tree).problems).toEqual([])
  })

  it('checks each path', () => {
    const deep = `${Array.from({ length: 32 }, (_, i) => `d${i}`).join('/')}/x.html`
    expect(
      codes(checkPush([file(deep, '<p>x</p>')], treeOf()).problems),
    ).toEqual(['too_deep'])
    expect(
      codes(checkPush([file('a\tb/x.html', '<p>x</p>')], treeOf()).problems),
    ).toEqual(['bad_name'])
  })

  it('refuses every problem code it knows', () => {
    const seen = new Set(
      codes(
        checkPush(
          [
            file('a/b.html', '<base href="/">'),
            file(
              'plan.html',
              '<form></form>\n' +
                '<form action="/x/"></form>\n' +
                '<form action="_x/"></form>\n' +
                '<form action="x"></form>\n' +
                '<form action="a%2Fb/"></form>\n' +
                '<form action="y/" data-closes="2026-10-20T18:00"></form>\n' +
                '<form action="z/"></form><form action="z/"></form>',
            ),
            file(`${'d/'.repeat(32)}x.html`, ''),
          ],
          treeOf({ 'a/b/index.html': 'page' }),
        ).problems,
      ),
    )
    const all: readonly PushProblemCode[] = [
      'page_folder_clash',
      'base_element',
      'form_without_action',
      'form_action_outside',
      'form_action_authored',
      'form_action_kind',
      'closes_without_offset',
      'forms_need_ids',
      'too_deep',
      'bad_name',
    ]
    expect([...seen].sort()).toEqual([...all].sort())
  })
})

describe('pathProblems', () => {
  it('passes good paths, up to the deepest a file may sit', () => {
    expect(pathProblems('plan.html')).toEqual([])
    expect(pathProblems('ملاحظات/ربع 🚀.html')).toEqual([])
    const deepest = Array.from({ length: 32 }, (_, i) => `d${i}`).join('/')
    expect(pathProblems(deepest)).toEqual([])
  })

  it('refuses a path deeper than a tree holds', () => {
    const path = Array.from({ length: 33 }, (_, i) => `d${i}`).join('/')
    expect(pathProblems(path)).toEqual([
      {
        code: 'too_deep',
        path,
        line: null,
        message: `${path}: the file sits 33 levels deep, and a tree holds files at most 32 levels deep.`,
        fix: 'Move it into a folder nearer the top of the tree.',
      },
    ])
  })

  it('refuses names a file or folder cannot have', () => {
    expect(
      pathProblems('a//b.html').map((problem) => [problem.code, problem.fix]),
    ).toEqual([['bad_name', 'Remove the extra slash.']])
    expect(pathProblems('a/../b.html')[0]?.message).toBe(
      'a/../b.html: ".." cannot be the name of a file or folder.',
    )
    expect(pathProblems('a\nb.html')[0]?.message).toBe(
      'a\nb.html: the name "a\\nb.html" holds a control character, such as a tab or a line break.',
    )
    const long = `${'x'.repeat(256)}.html`
    expect(pathProblems(long).map((problem) => problem.code)).toEqual([
      'bad_name',
    ])
    expect(pathProblems(long)[0]?.fix).toBe(
      'Shorten the name to 255 bytes or fewer.',
    )
  })
})

describe('describeProblems', () => {
  const one: PushProblem = {
    code: 'form_without_action',
    path: 'plan.html',
    line: 12,
    message: 'plan.html: the form on line 12 has no action.',
    fix: 'Add action="decisions/" for one file per person, or action="decisions.json" for one shared file.',
  }
  const two: PushProblem = {
    code: 'base_element',
    path: 'team/_layout.html',
    line: null,
    message: 'team/_layout.html: the <base> element is not allowed.',
    fix: 'Remove it.',
  }

  it('keeps a single problem as it is', () => {
    expect(describeProblems([one])).toEqual({
      message: one.message,
      fix: one.fix,
      path: 'plan.html',
    })
  })

  it('lists several, one per line', () => {
    expect(describeProblems([one, two])).toEqual({
      message:
        'This push has 2 problems:\n' +
        `- ${one.message} ${one.fix}\n` +
        `- ${two.message} ${two.fix}`,
      fix: 'Fix each file above, then push again.',
      path: 'plan.html',
    })
  })
})
