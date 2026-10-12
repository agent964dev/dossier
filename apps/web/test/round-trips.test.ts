// How many D1 and R2 round trips a push's requests and a visitor's page load
// make, one after another: on a deployment far from its database each one
// costs tens of milliseconds, so these counts bound the wall time.
import type { TreeId } from '@dossier/contracts'
import { SELF } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it } from 'vitest'

import { Browser } from './support/browser.ts'
import { harness, ORIGIN, testRuntime } from './support/harness.ts'
import { keySecretFor } from './support/keys.ts'
import { nodeAt, person, sha256Of, share, workspace } from './support/trees.ts'
import { tripCounting, tripReport } from './support/trips.ts'

afterEach(() => harness.reset())

const encoder = new TextEncoder()

const page = (n: number) =>
  `<!doctype html><title>Page ${n}</title><h1>Page ${n}</h1><acme-card>Card</acme-card><p>Text ${n}</p>`

const FILES: Record<string, string> = {
  '_layout.html':
    '<!doctype html><html><head><link rel="stylesheet" href="_theme.css"><title>Acme</title></head><body><header>Acme</header><slot></slot></body></html>',
  '_theme.css': ':root { --accent: teal; }',
  '_components/acme-card.js':
    "import './acme-shared.js'\nexport const card = 1",
  '_components/acme-shared.js': 'export const shared = 1',
  'index.html': page(0),
  ...Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`pages/p${i}.html`, page(i + 1)]),
  ),
}

const api = (secret: string, path: string, init: RequestInit = {}) =>
  SELF.fetch(`${ORIGIN}/_/api${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(init.body !== undefined && typeof init.body === 'string'
        ? { 'content-type': 'application/json' }
        : {}),
      ...init.headers,
    },
  })

const manifest = async (files: Record<string, string>) =>
  Promise.all(
    Object.entries(files).map(async ([path, text]) => ({
      path,
      sha256: await sha256Of(text),
      size: encoder.encode(text).length,
    })),
  )

/**
 * The most round trips each request may wait for one after another. Before
 * independent reads went out together, these were 9 to 28.
 */
const MOST_STEPS: Readonly<Record<string, number>> = {
  stage: 11,
  upload: 10,
  commit: 15,
  shell: 6,
  view: 7,
  'frame document': 7,
  'kit file': 6,
}

describe('round trips', () => {
  it('stay few on a push and a visitor’s page load', async () => {
    const owner = await person('owner')
    const ws = await workspace(owner)
    const secret = await keySecretFor(owner)
    // The Queue's webhook delivery runs beside the requests after a commit.
    const counter = tripCounting(env.DB, env.BLOBS, (sql) =>
      /e\.tree_id as treeId, e\.seq as seq|workspace_id as workspaceId, url/.test(
        sql,
      ),
    )
    harness.use(testRuntime({ env: counter.env }))
    const report: string[] = []
    const measure = async <A>(name: string, body: () => Promise<A>) => {
      counter.reset()
      const result = await body()
      const trips = tripReport(counter)
      report.push(
        `## ${name}: ${counter.trips().length} trips in ${counter.steps()} steps\n${trips}`,
      )
      const kind = Object.keys(MOST_STEPS).find((k) => name.startsWith(k))
      if (kind !== undefined) {
        expect(counter.steps(), `${name}\n${trips}`).toBeLessThanOrEqual(
          MOST_STEPS[kind]!,
        )
      }
      return result
    }

    const pushOnce = async (files: Record<string, string>, label: string) => {
      const listed = await manifest(files)
      const staged = await measure(`stage (${label})`, async () => {
        const response = await api(secret, '/pushes', {
          method: 'POST',
          body: JSON.stringify({
            target: `${ws.name}/acme`,
            baseSeq: null,
            baseTree: null,
            force: true,
            dryRun: false,
            message: null,
            share: [],
            files: listed,
          }),
        })
        expect(response.status).toBe(200)
        return (await response.json()) as {
          pushId: string | null
          missing: string[]
        }
      })
      if (staged.pushId === null) return null
      let first = true
      for (const file of listed) {
        if (!staged.missing.includes(file.sha256)) continue
        const upload = () =>
          api(secret, `/pushes/${staged.pushId}/blobs/${file.sha256}`, {
            method: 'PUT',
            body: encoder.encode(files[file.path]!),
            headers: { 'content-length': String(file.size) },
          })
        const response = first
          ? await measure(`upload ${file.path} (${label})`, upload)
          : await upload()
        first = false
        expect(response.status, await response.clone().text()).toBe(201)
      }
      return measure(`commit (${label})`, async () => {
        const response = await api(secret, `/pushes/${staged.pushId}/commit`, {
          method: 'POST',
        })
        expect(response.status, await response.clone().text()).toBe(200)
        return (await response.json()) as { treeId: TreeId }
      })
    }

    const pushed = await pushOnce(FILES, 'first')
    const treeId = pushed!.treeId
    const changed = Object.fromEntries(
      Object.entries(FILES).map(([path, text]) => [
        path,
        path.endsWith('.html') && path !== '_layout.html'
          ? `${text}<p>changed</p>`
          : text,
      ]),
    )
    await pushOnce(changed, 'pages changed')

    // A visitor opens the public root page.
    const root = await nodeAt(treeId, '')
    await share(treeId, root!.id, 'anyone', '*', 'read', owner)
    const visitor = new Browser()
    await measure('shell (new visitor)', () =>
      visitor.fetch(`/${ws.name}/acme/`),
    )
    const grant = await measure('view', async () => {
      const response = await visitor.fetch('/_/api/view', {
        method: 'POST',
        purpose: 'write',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tree: treeId, path: '' }),
      })
      expect(response.status).toBe(200)
      return (await response.json()) as { handle: string; seq: number }
    })
    const content = `${treeId}.content.test`
    const frame = (path: string) =>
      visitor.fetch(`/_/v/${grant.handle}/${grant.seq}/${path}`, {
        host: content,
        purpose: 'none',
      })
    const document = await measure('frame document', () => frame(''))
    expect(document.status).toBe(200)
    const html = await document.text()
    report.push(`## frame document\n${html.slice(0, 3000)}`)
    for (const path of [
      '_theme.css',
      '_components/acme-card.js',
      '_components/acme-shared.js',
    ]) {
      const response = await measure(`kit file ${path}`, () => frame(path))
      expect(response.status, path).toBe(200)
      report.push(
        `cache-control ${path}: ${response.headers.get('cache-control')}`,
      )
    }
    await measure('shell (returning visitor)', () =>
      visitor.fetch(`/${ws.name}/acme/`),
    )
    // Shown with --silent=false, for a look at each request's trips.
    console.log(report.join('\n\n'))
  })
})
