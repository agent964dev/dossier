// What an export makes of stylesheets that import each other, JSON modules,
// imports written as this tree's own URLs, fragments and srcsets, and how
// its body streams.
import type { Person } from '@dossier/contracts'
import { SELF } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { exportStream } from '../src/core/export-page.ts'
import { pushForms, repush, type FormTree } from './support/forms.ts'
import { harness, ORIGIN, testRuntime } from './support/harness.ts'
import { keySecretFor } from './support/keys.ts'
import { person, workspace } from './support/trees.ts'

afterEach(() => harness.reset())

const b64 = (text: string) => btoa(text)

const importMap = (html: string): Record<string, string> => {
  const match = /<script type="importmap">(.*?)<\/script>/s.exec(html)
  if (match === null) throw new Error('no import map')
  return (JSON.parse(match[1]!) as { imports: Record<string, string> }).imports
}

const dataText = (url: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) =>
      c.charCodeAt(0),
    ),
  )

let owner: Person
let ws: { id: string; name: string }
let key: string

beforeAll(async () => {
  owner = await person('owner')
  ws = await workspace(owner)
  key = await keySecretFor(owner)
})

const exportOf = (tree: FormTree, path: string) =>
  SELF.fetch(
    `${ORIGIN}/_/api/export?link=${encodeURIComponent(`${ORIGIN}/${ws.name}/${tree.name}/${path}`)}`,
    { headers: { authorization: `Bearer ${key}` } },
  )

describe('an export, after its review', () => {
  it('reads each stylesheet once, however its imports cycle', async () => {
    const tree = await pushForms(owner, ws, {
      'page.html':
        '<title>Cycle</title><link rel="stylesheet" href="a.css"><p>Hi</p>',
      'a.css': '@import "a.css"; @import "b.css"; @import "a.css"; .a{}',
      'b.css': '@import "a.css"; @import "b.css"; .b{}',
    })
    let reads = 0
    const blobs = new Proxy(env.BLOBS, {
      get(target, prop) {
        if (prop === 'get') {
          return (...args: Parameters<R2Bucket['get']>) => {
            reads += 1
            return target.get(...args)
          }
        }
        const value = Reflect.get(target, prop) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    harness.use(testRuntime({ env: { BLOBS: blobs } }))
    const response = await exportOf(tree, 'page')
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('.a{}')
    expect(reads).toBeLessThan(10)
    // A cycle imports an empty sheet, as a browser ignores it; nothing is
    // left to load from Dossier.
    expect(html).toContain('@import "data:text/css;base64,"')
    expect(html).not.toContain(`${ORIGIN}/${ws.name}/${tree.name}/a.css`)
  }, 20_000)

  it('carries a JSON module as JSON, as written', async () => {
    const data = '{"label": "from JSON"}\n'
    const tree = await pushForms(owner, ws, {
      'page.html':
        '<title>JSON</title><script type="module" src="app.js"></script>',
      'app.js':
        "import data from './data.json' with { type: 'json' }\nconst more = () => import('./more.json', { with: { type: 'json' } })\nconsole.log(data, more)",
      'data.json': data,
      'more.json': '[1, 2]',
    })
    const html = await (await exportOf(tree, 'page')).text()
    const map = importMap(html)
    expect(map['dossier-export/data.json']).toBe(
      `data:application/json;base64,${b64(data)}`,
    )
    expect(map['dossier-export/more.json']).toBe(
      `data:application/json;base64,${b64('[1, 2]')}`,
    )
    expect(dataText(map['dossier-export/app.js']!)).toContain(
      "import data from 'dossier-export/data.json' with { type: 'json' }",
    )
  })

  it('follows an import written as its own tree’s URL', async () => {
    // A tree whose module names itself by its content host, pushed twice so
    // the module can name the tree's ID.
    const first = await pushForms(owner, ws, {
      'page.html':
        '<title>Own</title><script type="module" src="app.js"></script>',
      'app.js': 'export {}',
      'shared.js': 'export const shared = 2',
    })
    const own = `https://${first.treeId}.content.test`
    await repush(first, {
      'page.html':
        '<title>Own</title><script type="module" src="app.js"></script>',
      'app.js': `import { shared } from '${own}/_/v/handle/1/shared.js'\nimport '${own}/_/base/test/lib/mermaid.js'\nconsole.log(shared)`,
      'shared.js': 'export const shared = 2',
    })
    const html = await (await exportOf(first, 'page')).text()
    const map = importMap(html)
    const app = dataText(map['dossier-export/app.js']!)
    expect(app).toContain("from 'dossier-export/shared.js'")
    expect(app).toContain("import 'dossier-export/base/lib/mermaid.js'")
    expect(dataText(map['dossier-export/shared.js']!)).toBe(
      'export const shared = 2',
    )
  })

  it('keeps fragments after inlined files, and rewrites srcsets with referenced separators', async () => {
    const tree = await pushForms(owner, ws, {
      'page.html':
        '<title>Bits</title><svg><use href="icons.svg#tick"></use></svg>' +
        '<video src="clip.mp4#t=10,20"></video>' +
        '<img srcset="a.png 1x&#44; b.png 2x">',
      'icons.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      'clip.mp4': 'clip-bytes',
      'a.png': 'a-png',
      'b.png': 'b-png',
    })
    const html = await (await exportOf(tree, 'page')).text()
    expect(html).toContain(
      `href="data:image/svg+xml;base64,${b64('<svg xmlns="http://www.w3.org/2000/svg"></svg>')}#tick"`,
    )
    expect(html).toContain(
      `src="data:video/mp4;base64,${b64('clip-bytes')}#t=10,20"`,
    )
    expect(html).toContain(
      `srcset="data:image/png;base64,${b64('a-png')} 1x, data:image/png;base64,${b64('b-png')} 2x"`,
    )
  })
})

describe('the export stream', () => {
  it('reads a file only as fast as the body is read, and stops when cancelled', async () => {
    let pulled = 0
    let cancelled = false
    const chunk = new Uint8Array(64 * 1024)
    const blobs = {
      get: async () => ({
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            // 16 MiB in all.
            if (pulled >= 16 * 1024 * 1024) return controller.close()
            pulled += chunk.length
            controller.enqueue(chunk)
          },
          cancel() {
            cancelled = true
          },
        }),
      }),
    } as unknown as R2Bucket
    const stream = exportStream(
      {
        pieces: [
          { kind: 'text', text: '<p>' },
          {
            kind: 'data-url',
            type: 'video/mp4',
            sha256: 'a'.repeat(64),
            size: 100 * 1024 * 1024,
          },
        ],
        bytes: 0,
        linked: [],
      },
      { DB: env.DB, BLOBS: blobs },
    )
    const reader = stream.getReader()
    await reader.read()
    await reader.read()
    await reader.read()
    await new Promise((resolve) => setTimeout(resolve, 50))
    // A few chunks ahead of the reader at most, never the whole file.
    expect(pulled).toBeLessThan(1024 * 1024)
    await reader.cancel()
    expect(cancelled).toBe(true)
  }, 10_000)
})

describe('an export, after its second review', () => {
  it('gives each occurrence of a stylesheet its own imports, cycles cut where they close', async () => {
    const tree = await pushForms(owner, ws, {
      'page.html':
        '<title>Both</title><link rel="stylesheet" href="a.css"><link rel="stylesheet" href="b.css">',
      'a.css': '@import "b.css";.a{color:red}',
      'b.css': '@import "a.css";.b{color:blue}',
    })
    const html = await (await exportOf(tree, 'page')).text()
    // The page's own sheets, after the base layer's style.
    const styles = [...html.matchAll(/<style>(.*?)<\/style>/gs)]
      .map((m) => m[1]!)
      .filter((style) => !style.startsWith('@layer dossier{'))
    expect(styles).toHaveLength(2)
    // a.css, importing b.css, whose import of a.css closes the cycle.
    expect(styles[0]).toContain('.a{color:red}')
    expect(styles[0]).toContain('.b%7Bcolor%3Ablue%7D')
    // b.css on its own, importing a.css whole.
    expect(styles[1]).toContain('.b{color:blue}')
    expect(styles[1]).toContain('.a%7Bcolor%3Ared%7D')
  })
})

describe('the export stream, after its second review', () => {
  const plan = {
    pieces: [
      { kind: 'text' as const, text: '<p>' },
      {
        kind: 'data-url' as const,
        type: 'image/png',
        sha256: 'b'.repeat(64),
        size: 65_537,
      },
      { kind: 'text' as const, text: '</p>' },
    ],
    bytes: 0,
    linked: [],
  }

  it('finishes a file whose last chunk is smaller than a base64 group', async () => {
    const chunks = [new Uint8Array(65_536).fill(1), new Uint8Array([2])]
    const blobs = {
      get: async () => ({
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            const next = chunks.shift()
            if (next === undefined) controller.close()
            else controller.enqueue(next)
          },
        }),
      }),
    } as unknown as R2Bucket
    const text = await Promise.race([
      new Response(exportStream(plan, { DB: env.DB, BLOBS: blobs })).text(),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('stalled'), 3000),
      ),
    ])
    const bytes = new Uint8Array(65_537).fill(1)
    bytes[65_536] = 2
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    expect(text).toBe(`<p>data:image/png;base64,${btoa(binary)}</p>`)
  })

  it('cancels a file read that arrives after the export was cancelled', async () => {
    let cancelled = false
    let answer: () => void = () => {}
    const blobs = {
      get: () =>
        new Promise((resolve) => {
          answer = () =>
            resolve({
              body: new ReadableStream<Uint8Array>({
                pull(controller) {
                  controller.enqueue(new Uint8Array(3))
                },
                cancel() {
                  cancelled = true
                },
              }),
            })
        }),
    } as unknown as R2Bucket
    const reader = exportStream(plan, { DB: env.DB, BLOBS: blobs }).getReader()
    await reader.read()
    const pending = reader.read()
    await new Promise((resolve) => setTimeout(resolve, 10))
    // The export is cancelled while R2 has not answered yet.
    await reader.cancel()
    answer()
    await pending.catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(cancelled).toBe(true)
  })
})
