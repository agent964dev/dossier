import type { SearchMode } from '@dossier/contracts'
import { env } from 'cloudflare:workers'
import { Effect, FastCheck as fc } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Access,
  Files,
  Search,
  TreeStore,
  type Caller,
} from '../src/core/index.ts'
import { harness, testRuntime, withRuntime } from './support/harness.ts'
import { runAs } from './support/people.ts'
import {
  agent,
  join,
  nodeAt,
  person,
  pushAll,
  ref,
  share,
  team,
  workspace,
} from './support/trees.ts'
import { exec, recordingStatements, rows } from './support/d1.ts'

afterEach(() => harness.reset())
const html = (title: string, body: string, head = '') =>
  `<html><head><title>${title}</title>${head}</head><body>${body}</body></html>`
const search = (who: Caller, text: string, mode: SearchMode = 'content') =>
  runAs(
    who,
    Effect.flatMap(Search, (s) => s.query({ text, mode, offset: 0 })),
  )
const places = (p: Awaited<ReturnType<typeof search>>) =>
  p.results.map((r) => r.node.path)
const world = async (files: Record<string, string>) => {
  const owner = await person('reviewowner')
  const ws = await workspace(owner)
  const key = await agent(owner)
  const name = `review${crypto.randomUUID().slice(0, 8)}`
  const pushed = await pushAll(key, `${ws.name}/${name}`, files)
  if (!('number' in pushed)) throw new Error('no push')
  const reader = await person('reviewreader')
  const readerKey = await agent(reader)
  const root = `${ws.name}/${name}`
  return {
    owner,
    ws,
    key,
    name,
    treeId: pushed.treeId,
    reader,
    readerKey,
    root,
  }
}
const grant = async (t: Awaited<ReturnType<typeof world>>, path: string) =>
  share(
    t.treeId,
    (await nodeAt(t.treeId, path))!.id,
    'email',
    t.reader.email,
    'read',
    t.owner,
  )

/** Run a real mutation after the search batch has read, before point checks. */
const afterSearchBatch = (action: () => Promise<unknown>) => {
  let armed = true
  const real = new WeakMap<object, D1PreparedStatement>()
  const hit = new WeakSet<object>()
  const wrap = (
    s: D1PreparedStatement,
    matching: boolean,
  ): D1PreparedStatement => {
    const p = new Proxy(s, {
      get(t, prop) {
        if (prop === 'bind')
          return (...v: unknown[]) => wrap(t.bind(...v), matching)
        const value = Reflect.get(t, prop, t)
        return typeof value === 'function' ? value.bind(t) : value
      },
    })
    real.set(p, s)
    if (matching) hit.add(p)
    return p
  }
  return new Proxy(env.DB, {
    get(t, prop) {
      if (prop === 'prepare')
        return (sql: string) =>
          wrap(t.prepare(sql), sql.includes('from search_pages'))
      if (prop === 'batch')
        return async (s: D1PreparedStatement[]) => {
          const result = await t.batch(s.map((p) => real.get(p) ?? p))
          if (armed && s.some((p) => hit.has(p))) {
            armed = false
            await withRuntime(testRuntime(), action)
          }
          return result
        }
      const value = Reflect.get(t, prop, t)
      return typeof value === 'function' ? value.bind(t) : value
    },
  })
}

it('does not expose an unreadable companion through result order', async () => {
  const tag = `rank${crypto.randomUUID().replaceAll('-', '')}`
  const files = {
    'a.html': html(
      'A',
      `${tag} ${tag} ${tag}`,
      '<link rel="alternate" type="text/markdown" href="private/a.md">',
    ),
    'b.html': html('B', `${tag} ${tag}`),
    'private/a.md': 'private',
  }
  const t = await world(files)
  await grant(t, 'a.html')
  await grant(t, 'b.html')
  const before = await search(t.readerKey, tag)
  files['private/a.md'] = 'confidential '.repeat(4000)
  const pushed = await pushAll(t.key, t.root, files, { force: true })
  expect('number' in pushed).toBe(true)
  const after = await search(t.readerKey, tag)
  console.log('PRIVATE_COMPANION_ORDER', places(before), places(after))
  expect(places(after)).toEqual(places(before))
})

it('does not expose words in entirely unreadable pages through result order', async () => {
  const a = `alpha${crypto.randomUUID().replaceAll('-', '')}`
  const b = `bravo${crypto.randomUUID().replaceAll('-', '')}`
  const files: Record<string, string> = {
    'a.html': html('A', `${a} ${a} ${a} ${b}`),
    'b.html': html('B', `${a} ${b} ${b} ${b}`),
  }
  for (let n = 0; n < 15; n++)
    files[`private/p${n}.html`] = html('Hidden', `${a} filler filler`)
  const t = await world(files)
  await grant(t, 'a.html')
  await grant(t, 'b.html')
  const before = await search(t.readerKey, `${a} ${b}`)
  for (let n = 0; n < 15; n++)
    files[`private/p${n}.html`] = html('Hidden', `${b} filler filler`)
  expect(
    'number' in (await pushAll(t.key, t.root, files, { force: true })),
  ).toBe(true)
  const after = await search(t.readerKey, `${a} ${b}`)
  console.log('PRIVATE_WORD_ORDER', places(before), places(after))
  expect(places(after)).toEqual(places(before))
})

it('does not return a page after it moves out of the reader shared folder before final checks', async () => {
  const tag = `move${crypto.randomUUID().replaceAll('-', '')}`
  const t = await world({
    'shared/p.html': html('Shared', tag),
    'private/keep.html': html('Keep', 'nothing'),
  })
  await grant(t, 'shared')
  harness.use(
    testRuntime({
      env: {
        DB: afterSearchBatch(() =>
          runAs(
            t.key,
            Effect.flatMap(Files, (f) =>
              f.mv({
                from: ref(`${t.root}/shared/p.html`),
                to: ref(`${t.root}/private/p.html`),
              }),
            ),
          ),
        ),
      },
    }),
  )
  const found = await search(t.readerKey, tag)
  const current = await runAs(
    t.key,
    Effect.flatMap(TreeStore, (s) => s.locate(ref(`${t.root}/private/p.html`))),
  )
  if ('missing' in current) throw new Error('missing moved node')
  const canReadNow = await runAs(
    t.readerKey,
    Effect.flatMap(Access, (a) => a.require('read', current.node)).pipe(
      Effect.isSuccess,
    ),
  )
  console.log('MOVED_AFTER_BATCH', places(found), { canReadNow })
  expect(canReadNow).toBe(false)
  expect(found.results).toEqual([])
})

it('finds the readable fallback companion when a named companion is private', async () => {
  const tag = `fallback${crypto.randomUUID().replaceAll('-', '')}`
  const t = await world({
    'p.html': html(
      'Page',
      'plain body',
      '<link rel="alternate" type="text/markdown" href="private/p.md">',
    ),
    'p.md': `Visible ${tag}`,
    'private/p.md': 'private only',
  })
  await grant(t, 'p.html')
  await grant(t, 'p.md')
  const found = await search(t.readerKey, tag)
  console.log('READABLE_FALLBACK', places(found))
  expect(places(found)).toEqual(['p.html'])
})

it('does not retain next/count from a revoked share before final checks', async () => {
  const tag = `paging${crypto.randomUUID().replaceAll('-', '')}`
  const files: Record<string, string> = {}
  for (let n = 0; n < 21; n++) files[`shared/p${n}.html`] = html('Page', tag)
  const t = await world(files)
  await grant(t, 'shared')
  harness.use(
    testRuntime({
      env: {
        DB: afterSearchBatch(() =>
          exec(
            'delete from shares where tree_id = ? and target = ?',
            t.treeId,
            t.reader.email,
          ),
        ),
      },
    }),
  )
  const found = await search(t.readerKey, tag)
  console.log('REVOKED_NEXT', { count: found.results.length, next: found.next })
  expect(found.results).toEqual([])
  expect(found.next).toBeNull()
})

it('indexes an attachment renamed to become a page', async () => {
  const tag = `rename${crypto.randomUUID().replaceAll('-', '')}`
  const t = await world({
    'draft.txt': html('Draft', tag),
    'keep.html': html('Keep', 'nothing'),
  })
  await runAs(
    t.key,
    Effect.flatMap(Files, (f) =>
      f.mv({
        from: ref(`${t.root}/draft.txt`),
        to: ref(`${t.root}/draft.html`),
      }),
    ),
  )
  const found = await search(t.key, tag)
  console.log('RENAMED_INTO_PAGE', places(found))
  expect(places(found)).toEqual(['draft.html'])
})

// Further checks of the same review, written before the fixes.

it('never shows a private named companion’s words in the snippet of a page found through its readable same-name companion', async () => {
  const tag = `snip${crypto.randomUUID().replaceAll('-', '')}`
  const t = await world({
    'p.html': html(
      'Page',
      'plain body',
      '<link rel="alternate" type="text/markdown" href="private/p.md">',
    ),
    'p.md': `Visible ${tag} here`,
    'private/p.md': `Secret ${tag} ${tag} ${tag} words`,
  })
  await grant(t, 'p.html')
  await grant(t, 'p.md')
  const found = await search(t.readerKey, tag)
  expect(places(found)).toEqual(['p.html'])
  const text = found.results
    .flatMap((r) => (r.snippet ?? []).map((p) => p.text))
    .join('')
  expect(text).toContain('Visible')
  expect(text).not.toContain('Secret')
  // The owner reads the named companion: it is the one searched for them.
  const owner = await search(t.key, tag)
  const shown = owner.results
    .flatMap((r) => (r.snippet ?? []).map((p) => p.text))
    .join('')
  expect(shown).toContain('Secret')
})

it('indexes pages that become pages when their folder moves out of a `_` folder', async () => {
  const tag = `unhide${crypto.randomUUID().replaceAll('-', '')}`
  const t = await world({
    '_drafts/plan.html': html(`${tag} plan`, 'body'),
    'keep.html': html('Keep', 'x'),
  })
  expect(places(await search(t.key, tag, 'titles'))).toEqual([])
  await runAs(
    t.key,
    Effect.flatMap(Files, (f) =>
      f.mv({ from: ref(`${t.root}/_drafts`), to: ref(`${t.root}/drafts`) }),
    ),
  )
  expect(places(await search(t.key, tag, 'titles'))).toEqual([
    'drafts/plan.html',
  ])
})

it('orders results by where the caller’s own words match: title, then path, then text', async () => {
  const tag = `order${crypto.randomUUID().replaceAll('-', '')}`
  const t = await world({
    'a.html': html('Plain', `${tag}`),
    [`${tag}/b.html`]: html('Plain', 'x'),
    'c.html': html(`${tag} title`, 'x'),
  })
  expect(places(await search(t.key, tag, 'content'))).toEqual([
    'c.html',
    'a.html',
  ])
  // Pages by where they matched, then the folder by its name.
  expect(places(await search(t.key, tag, 'titles'))).toEqual([
    'c.html',
    `${tag}/b.html`,
    tag,
  ])
})

describe('agreement with the point check, carried pages and revocation', () => {
  it('returns exactly the pages require(read) grants, before and after a share is revoked, with pages a shared page frames', async () => {
    const admin = await person('padmin')
    const ws = await workspace(admin)
    const member = await person('pmember')
    await join(ws, member)
    const outsider = await person('poutsider')
    const design = await team(ws, 'Design', [member])
    const FOLDERS = ['', 'a', 'a/b', 'c']
    const at = (folder: string, name: string) =>
      folder === '' ? name : `${folder}/${name}`
    // Folders, their pages, and a page that frames a/b/p.html.
    const NODES = [
      ...FOLDERS,
      ...FOLDERS.map((f) => at(f, 'p.html')),
      'c/host.html',
    ]
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          shares: fc.array(
            fc.record({
              at: fc.integer({ min: 0, max: NODES.length - 1 }),
              kind: fc.constantFrom('email', 'workspace', 'anyone', 'team'),
              role: fc.constantFrom('read', 'respond', 'write'),
              by: fc.constantFrom('admin', 'member'),
            }),
            { minLength: 1, maxLength: 4 },
          ),
          caller: fc.constantFrom('member', 'outsider', 'readonly', 'scoped'),
          scopeAt: fc.integer({ min: 0, max: FOLDERS.length - 1 }),
          revoke: fc.nat(),
        }),
        async (s) => {
          const tag = `prop${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
          const files: Record<string, string> = {}
          for (const f of FOLDERS) {
            files[at(f, 'p.html')] = html(
              `${tag} page`,
              `${tag} text`,
              '<link rel="alternate" type="text/markdown" href="notes.md">',
            )
            files[at(f, 'notes.md')] = `${tag}note`
          }
          files['c/host.html'] = html(
            `${tag} host`,
            `${tag} host <iframe src="../a/b/p"></iframe>`,
          )
          const name = `prop${crypto.randomUUID().slice(0, 8)}`
          const pushed = await pushAll(
            await agent(admin),
            `${ws.name}/${name}`,
            files,
          )
          if (!('number' in pushed)) throw new Error('no push')
          const treeId = pushed.treeId
          const ids: string[] = []
          for (const sh of s.shares) {
            const id = crypto.randomUUID()
            ids.push(id)
            await exec(
              `insert into shares (id, tree_id, node_id, target_kind, target, role, created_by, created_at)
               values (?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
              id,
              treeId,
              (await nodeAt(treeId, NODES[sh.at]!))!.id,
              sh.kind,
              sh.kind === 'email'
                ? (s.caller === 'outsider'
                    ? outsider
                    : member
                  ).email.toLowerCase()
                : sh.kind === 'workspace'
                  ? ws.id
                  : sh.kind === 'team'
                    ? design.id
                    : '',
              sh.role,
              sh.by === 'admin' ? admin.id : member.id,
              Date.now(),
            )
          }
          const caller =
            s.caller === 'member'
              ? await agent(member)
              : s.caller === 'outsider'
                ? await agent(outsider)
                : s.caller === 'readonly'
                  ? await agent(member, { readOnly: true })
                  : await agent(member, {
                      scope: (await nodeAt(treeId, FOLDERS[s.scopeAt]!))!
                        .id as never,
                    })
          const expectAgreement = async (when: string) => {
            const pages = await rows<Record<string, unknown>>(
              `select * from nodes where tree_id = ? and deleted_at is null and path like '%.html'`,
              treeId,
            )
            const readable = new Set<string>()
            for (const row of pages) {
              const node = {
                id: row.id,
                treeId: row.tree_id,
                parentId: row.parent_id,
                name: row.name,
                path: row.path,
                depth: row.depth,
                kind: row.kind,
                origin: row.origin,
                ownerId: null,
                currentVersionId: row.current_version_id,
                createdAt: row.created_at,
                deletedAt: null,
                underscoreFrom: null,
              }
              if (
                await runAs(
                  caller,
                  Effect.flatMap(Access, (a) =>
                    a.require('read', node as never),
                  ).pipe(Effect.isSuccess),
                )
              ) {
                readable.add(row.path as string)
              }
            }
            for (const mode of ['titles', 'content'] as const) {
              const found = await search(caller, tag, mode)
              expect(
                new Set(places(found)),
                `${when} ${mode} ${JSON.stringify(s)}`,
              ).toEqual(readable)
            }
          }
          await expectAgreement('before')
          await exec(
            'delete from shares where id = ?',
            ids[s.revoke % ids.length],
          )
          await expectAgreement('after revoking one share')
        },
      ),
      {
        numRuns: 25,
        examples: [
          [
            {
              // A member's share of the framing page carries the framed page
              // only while the member holds it themselves.
              shares: [
                {
                  at: NODES.indexOf('c/host.html'),
                  kind: 'email',
                  role: 'read',
                  by: 'member',
                },
                {
                  at: NODES.indexOf(''),
                  kind: 'workspace',
                  role: 'read',
                  by: 'admin',
                },
              ],
              caller: 'outsider',
              scopeAt: 0,
              revoke: 1,
            },
          ],
        ],
      },
    )
  }, 180_000)
})

it('keeps every search statement under 90 KB and 100 bound values for the widest caller: a 254-character email, 200 teams and a key scoped deep in the tree', async () => {
  const owner = await person('wideowner')
  const ws = await workspace(owner)
  const email =
    `${'m'.repeat(64)}@${'d'.repeat(60)}.${'e'.repeat(60)}.${'f'.repeat(60)}.example.org`.slice(
      0,
      254,
    )
  const id = crypto.randomUUID().replaceAll('-', '')
  const now = Date.now()
  await exec(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at) values (?, 'm', ?, 1, ?, ?)`,
    id,
    email,
    now,
    now,
  )
  await exec(
    `insert into people (user_id, email_authority, first_sign_in_at, last_sign_in_at) values (?, 'google', ?, ?)`,
    id,
    now,
    now,
  )
  const member = { id, email, name: 'm', image: null } as never
  await join(ws, member)
  const statements: D1PreparedStatement[] = []
  for (let n = 0; n < 200; n += 1) {
    const teamId = crypto.randomUUID()
    statements.push(
      env.DB.prepare(
        'insert into teams (id, workspace_id, name, created_by, created_at) values (?, ?, ?, ?, ?)',
      ).bind(teamId, ws.id, `Team ${n}`, owner.id, now),
      env.DB.prepare(
        'insert into team_members (team_id, user_id, created_at) values (?, ?, ?)',
      ).bind(teamId, id, now),
    )
  }
  await env.DB.batch(statements)
  const deep = Array.from(
    { length: 30 },
    (_, n) => `${n}${'d'.repeat(200)}`,
  ).join('/')
  const pushed = await pushAll(await agent(owner), `${ws.name}/wide`, {
    [`${deep}/p.html`]: html(
      'erbil plan',
      'body',
      '<link rel="alternate" href="x.md">',
    ),
    [`${deep}/p.md`]: 'erbil plan',
    [`${deep}/x.md`]: 'erbil plan',
  })
  if (!('number' in pushed)) throw new Error('no push')
  await share(
    pushed.treeId,
    (await nodeAt(pushed.treeId, ''))!.id,
    'workspace',
    ws.id,
    'read',
    owner,
  )
  const scoped = await agent(member, {
    scope: (await nodeAt(pushed.treeId, deep))!.id as never,
  })
  const recorded = recordingStatements(env.DB)
  harness.use(testRuntime({ env: { DB: recorded.db } }))
  const words = 'erbil plan one two three four five six'
  for (const mode of ['content', 'titles'] as const) {
    await runAs(
      scoped,
      Effect.flatMap(Search, (s) => s.query({ text: words, mode, offset: 0 })),
    )
  }
  expect(places(await search(scoped, 'erbil plan'))).toEqual([`${deep}/p.html`])
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength
  for (const statement of recorded.seen()) {
    expect(bytes(statement.sql)).toBeLessThan(90_000)
    expect(statement.binds.length).toBeLessThanOrEqual(100)
  }
}, 120_000)
