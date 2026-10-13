import { PAGE_ERROR_CODES } from '@dossier/contracts/bridge'
import { describe, expect, it } from 'vitest'

import { verbs } from './commands/index.ts'
import { guide, guideMarkdown, sectionOf } from './guide.ts'
import { harness, stubFetch } from './test-support.ts'

const TITLES = [
  'Dossier',
  'Kits',
  'Layouts',
  'Themes',
  'Components',
  'Base layer',
  'Embedding',
  'Forms',
  'Page client',
  'Live data',
  'Agent versions',
  'Reading',
  'Sharing',
  'Export',
  'History',
]

describe('the agent guide', () => {
  it('holds every convention, in order, each with its own text', () => {
    const { conventions } = guide()
    expect(conventions.map((c) => c.title)).toEqual(TITLES)
    for (const section of conventions) {
      expect(section.markdown).not.toBe('')
      expect(section.markdown.startsWith('## ')).toBe(false)
    }
  })

  it('says what the conventions promise', () => {
    const text = guide()
      .conventions.map((c) => c.markdown)
      .join('\n')
    for (const phrase of [
      'One push is one change',
      "tree's own origin",
      'the closest one wins',
      '`<slot></slot>`',
      'innermost wins',
      'not rewritten',
      '--font-display',
      '`_components/<tag>.js`',
      '`_components/<tag>.md`',
      'html[data-dossier-embedded] .site-header { display: none }',
      '`<link rel="alternate"',
      'Data: answers/ (3 files) · Comments: 2',
      'dossier read <workspace>/<tree>/<folder>/',
      'DOSSIER_JSON=1',
    ]) {
      expect(text).toContain(phrase)
    }
  })

  it('prints the Dossier section, the generated verbs and exit codes, then the other conventions', async () => {
    const fetch = stubFetch(() => new Response(null, { status: 500 }))
    const cli = await harness({ fetch: fetch.fetch })
    try {
      expect(await cli.run(['--agent-info'])).toBe(0)
      const markdown = cli.stdout()
      expect(markdown).toBe(guideMarkdown(guide()))
      const at = (heading: string) => markdown.indexOf(`\n## ${heading}\n`)
      const order = [
        at('Dossier'),
        at('Verbs'),
        at('Exit codes'),
        ...TITLES.slice(1).map(at),
      ]
      expect(order.every((index) => index > 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
      for (const verb of guide().verbs) {
        expect(markdown).toContain(`### ${verb.name}\n`)
        expect(markdown).toContain(verb.usage)
      }
      expect(guide().verbs.map((verb) => verb.name)).toHaveLength(verbs.length)
      expect(markdown).toContain('dossier read [--json] <target>')
      expect(markdown).toContain('| 3 | not found or no access |')

      expect(await cli.run(['--agent-info', '--json'])).toBe(0)
      const data = JSON.parse(cli.stdout())
      expect(data.conventions.map((c: { title: string }) => c.title)).toEqual(
        TITLES,
      )
      expect(data).toEqual(guide())
    } finally {
      await cli.cleanup()
    }
  })

  it('gives agents the page client: its calls, path rules, ten error codes and the live example', async () => {
    const fetch = stubFetch(() => new Response(null, { status: 500 }))
    const cli = await harness({ fetch: fetch.fetch })
    try {
      expect(await cli.run(['--agent-info'])).toBe(0)
      const markdown = cli.stdout()
      for (const call of [
        'dossier.me',
        'dossier.page // { path, link, push, embedded, exported }',
        'await dossier.ready',
        'dossier.read(path)',
        'dossier.watch(path, onChange)',
        'dossier.write(path, patch, { replace })',
        'dossier.withdraw(path)',
        'dossier.upload(file)',
        '`{ path, data, by, at, push }`',
        "`write('ideas/~/', patch)`",
        '`<page name>.uploads/<email>/<name>`',
      ]) {
        expect(markdown).toContain(call)
      }
      for (const rule of [
        'Paths are relative to the page, like a URL',
        '`/` starts at the tree root and\nnever goes above it',
        "`~` is the viewer's email",
        '`answers/~.json` is `questions/answers/sara@acme.com.json`',
        '`../../../x.json` leaves the tree and is refused with `forbidden`',
      ]) {
        expect(markdown).toContain(rule)
      }
      expect(markdown).toContain('`DossierError { code, message, fix, path }`')
      for (const code of PAGE_ERROR_CODES) {
        expect(markdown).toContain(`- \`${code}\`: `)
      }
      expect(markdown).toContain('Any other code\n  arrives as `unavailable`')
      for (const line of [
        "customElements.define('acme-results', AcmeResults)",
        "this.stop = dossier.watch(this.getAttribute('src'), (docs) =>",
        '`<acme-results src="../questions/answers/"></acme-results>`',
        'Paths resolve from\nthe page, not the module',
        'dossier watch <workspace>/<tree>/<path>',
      ]) {
        expect(markdown).toContain(line)
      }
    } finally {
      await cli.cleanup()
    }
  })

  it('gives agents the sharing rules, with what a page shared on its own carries', async () => {
    const fetch = stubFetch(() => new Response(null, { status: 500 }))
    const cli = await harness({ fetch: fetch.fetch })
    try {
      expect(await cli.run(['--agent-info'])).toBe(0)
      const markdown = cli.stdout()
      const at = markdown.indexOf('\n## Sharing\n')
      expect(at).toBeGreaterThan(0)
      const sharing = markdown.slice(at)
      expect(sharing).toContain(
        'A page shared on its own carries the files its markup loads, not ' +
          'files referenced only from inside its stylesheets or scripts, or ' +
          'URLs its scripts build. Share the folder for those, or keep them ' +
          'in a `_` folder.',
      )
      for (const phrase of [
        '`read`',
        '`respond`',
        '`write`',
        'Roles add up across shares',
        'a lower node\ncannot narrow it',
        '`sara@acme.com`, `team:Design`, `workspace`, `anyone`',
        'Workspace admins hold write on every tree',
        'sara@acme.com --remove',
        '--share sara@acme.com:respond --share anyone:read',
        'sign in with Google',
        'never a\npage above it',
        "closes that person's live watches",
      ]) {
        expect(sharing).toContain(phrase)
      }
      expect(markdown).toContain('### share\n')
      expect(markdown).toContain('dossier share [--remove] [--json] <path>')
    } finally {
      await cli.cleanup()
    }
  })

  it('lists export after read, and says what an exported file holds', async () => {
    const fetch = stubFetch(() => new Response(null, { status: 500 }))
    const cli = await harness({ fetch: fetch.fetch })
    try {
      expect(await cli.run(['--agent-info'])).toBe(0)
      const markdown = cli.stdout()
      const names = guide().verbs.map((verb) => verb.name)
      expect(names.indexOf('export')).toBe(names.indexOf('read') + 1)
      expect(markdown).toContain('### export\n')
      expect(markdown).toContain(
        'dossier export [(-o, --output text)] [--json] <link>',
      )
      const at = markdown.indexOf('\n## Export\n')
      expect(at).toBeGreaterThan(0)
      const exporting = markdown.slice(at)
      for (const phrase of [
        'opens offline',
        'layouts, theme and\ncomponents',
        'images and fonts',
        'base libraries',
        'page client in export mode',
        "page's form\ntargets, its comments",
        "under the page's folder",
        'in that\nbrowser only',
        '50 MiB',
        'Linked, not included:',
        'URLs page code builds at run time are not inlined',
        '`{ "file", "bytes", "linked" }`',
      ]) {
        expect(exporting).toContain(phrase)
      }
    } finally {
      await cli.cleanup()
    }
  })

  it('gives agents history: the five verbs and what deleting, restoring and moving keep', async () => {
    const fetch = stubFetch(() => new Response(null, { status: 500 }))
    const cli = await harness({ fetch: fetch.fetch })
    try {
      expect(await cli.run(['--agent-info'])).toBe(0)
      const markdown = cli.stdout()
      for (const usage of [
        'dossier rm [--json] <path>',
        'dossier mv [--json] <from> <to>',
        'dossier log [--cursor text] [--json] <path>',
        'dossier diff [--json] <path> [<from>] [<to>]',
        'dossier restore --to text [--json] <path>',
      ]) {
        expect(markdown).toContain(usage)
      }
      const history = markdown.slice(markdown.indexOf('\n## History\n'))
      for (const phrase of [
        'dossier log agent964/acme/questions/ --cursor <c>',
        'dossier diff agent964/acme/plan.html 11 12',
        'dossier restore agent964/acme/plan.html --to 12',
        'dossier mv agent964/acme studio/acme',
        'within the retention period',
        'just after it',
        'keeps data written since',
        'its old link keeps working',
        'ends its team shares',
      ]) {
        expect(history).toContain(phrase)
      }
    } finally {
      await cli.cleanup()
    }
  })

  it('refuses a convention file without its title line', () => {
    expect(sectionOf('## Kits\n\nText.\n')).toEqual({
      title: 'Kits',
      markdown: 'Text.',
    })
    expect(() => sectionOf('Kits\n\nText.')).toThrow('## <title>')
  })
})
