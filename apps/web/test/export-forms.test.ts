// A page with many forms exports with every answer its exporter reads in
// each form's target: the targets travel as one bound value, each once, so
// the snapshot stays within D1's limits however many forms the page holds.
import type { ExportData } from '@dossier/contracts/bridge'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { Pages } from '../src/core/index.ts'
import { recordingStatements } from './support/d1.ts'
import { pageWith, pushForms } from './support/forms.ts'
import { harness, testRuntime } from './support/harness.ts'
import { runAs, sessionFor } from './support/people.ts'
import { dataFile, person, ref, workspace } from './support/trees.ts'

afterEach(() => harness.reset())

/**
 * 150 forms with targets of their own, then 100 sharing one, all outside
 * the page's own folder.
 */
const FORMS = [
  ...Array.from(
    { length: 100 },
    (_, n) =>
      `<form action="../t${n}/" method="post"><input name="a"><button>Send</button></form>`,
  ),
  ...Array.from(
    { length: 50 },
    (_, n) =>
      `<form action="../s${n}.json" method="post"><input name="a"><button>Send</button></form>`,
  ),
  ...Array.from(
    { length: 100 },
    (_, n) =>
      `<form id="f${n}" action="../shared/" method="post"><input name="a"><button>Send</button></form>`,
  ),
].join('\n')

const dataOf = async (response: Response): Promise<ExportData> => {
  const html = await response.text()
  const match =
    /<script type="application\/json" id="dossier-export">(.*?)<\/script>/s.exec(
      html,
    )
  if (match === null) throw new Error('no export data')
  return JSON.parse(match[1]!) as ExportData
}

const bytes = (text: string) => new TextEncoder().encode(text).byteLength

describe('exporting a page with 250 forms', () => {
  it('takes the answers in every target within D1’s limits', async () => {
    const owner = await person('owner')
    const ws = await workspace(owner)
    const tree = await pushForms(owner, ws, {
      'plans/plan.html': pageWith(FORMS, 'Plan'),
      'other/page.html': pageWith('<p>Other.</p>', 'Other'),
    })
    const writer = await person('writer')
    await dataFile(
      tree.treeId,
      `t99/${writer.email}.json`,
      { a: 'last' },
      writer,
    )
    await dataFile(tree.treeId, 's49.json', { a: 'shared file' }, writer)
    await dataFile(
      tree.treeId,
      `shared/${writer.email}.json`,
      { a: 'x' },
      writer,
    )
    // Outside every target and the page's folder: never in the file.
    await dataFile(
      tree.treeId,
      `other/answers/${writer.email}.json`,
      { a: 'no' },
      writer,
    )
    const recorded = recordingStatements(env.DB)
    harness.use(testRuntime({ env: { DB: recorded.db } }))
    const served = await runAs(
      await sessionFor(owner),
      Effect.flatMap(Pages, (p) =>
        p.export({ ref: ref(`${ws.name}/${tree.name}/plans/plan`) }),
      ),
    )
    expect(served.kind).toBe('export')
    const over = recorded
      .seen()
      .filter((s) => s.binds.length > 100 || bytes(s.sql) > 100_000)
      .map((s) => `${s.binds.length} binds, ${bytes(s.sql)} bytes`)
    expect(over).toEqual([])
    const data = await dataOf(new Response(served.html))
    expect(data.files.map((f) => f.path).sort()).toEqual(
      [
        `t99/${writer.email}.json`,
        's49.json',
        `shared/${writer.email}.json`,
      ].sort(),
    )
  }, 120_000)
})
