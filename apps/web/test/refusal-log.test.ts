// Every refused request leaves one log line: who asked, what they asked for,
// which tree and path, and the refusal's code. A line never holds a key's
// secret, a session cookie or a view handle.
import { SELF } from 'cloudflare:test'
import type { Person } from '@dossier/contracts'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { Browser, signedIn } from './support/browser.ts'
import { pageWith, pushForms, repush, type FormTree } from './support/forms.ts'
import { harness, ORIGIN } from './support/harness.ts'
import { callerOf, fresh } from './support/people.ts'
import { keySecretFor } from './support/keys.ts'
import { REFUSING_SCREEN } from './support/screens.ts'
import { person, workspace } from './support/trees.ts'

afterEach(() => {
  harness.reset()
  vi.restoreAllMocks()
})

let owner: Person
let tree: FormTree
let outsider: Browser
let outsiderId: string

beforeAll(async () => {
  owner = await person('owner')
  const ws = await workspace(owner)
  tree = await pushForms(owner, ws, {
    'secret/plan.html': pageWith('<p>Plan</p>', 'Plan'),
  })
  await repush(tree, {
    'secret/plan.html': pageWith('<p>Plan, again</p>', 'Plan'),
  })
  outsider = await signedIn(fresh())
  outsiderId = (await callerOf(outsider)).person!.id
})

/** The refusal lines logged while `body` runs. */
const refusals = async (body: () => Promise<unknown>) => {
  const log = vi.spyOn(console, 'log')
  await body()
  const lines = log.mock.calls
    .map((call) => call[0])
    .filter(
      (line): line is string =>
        typeof line === 'string' && line.includes('"message":"refused"'),
    )
  log.mockRestore()
  return lines
}

const one = (lines: readonly string[]) => {
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0]!) as Record<string, unknown>
}

describe('a refused request', () => {
  it("logs a visitor's API refusal with the tree and path asked", async () => {
    const lines = await refusals(async () => {
      const response = await new Browser().fetch(
        `/_/api/events?tree=${tree.treeId}&path=secret/plan.html`,
        { purpose: 'read' },
      )
      expect(response.status).toBe(401)
    })
    expect(one(lines)).toMatchObject({
      message: 'refused',
      code: 'sign_in_required',
      status: 401,
      method: 'GET',
      route: '/_/api/events',
      tree: tree.treeId,
      path: 'secret/plan.html',
      actor: null,
      key: null,
      via: 'visitor',
    })
  })

  it("logs an agent's refusal as its person and key, never the key's secret", async () => {
    const secret = await keySecretFor(await person('agent-owner'))
    const lines = await refusals(async () => {
      const response = await SELF.fetch(
        `${ORIGIN}/_/api/read?path=${encodeURIComponent(`${tree.ws.name}/${tree.name}/secret/plan.html`)}`,
        { headers: { authorization: `Bearer ${secret}` } },
      )
      expect(response.status).toBe(404)
    })
    const line = one(lines)
    expect(line).toMatchObject({
      code: 'not_found',
      via: 'agent',
      route: '/_/api/read',
      path: `${tree.ws.name}/${tree.name}/secret/plan.html`,
    })
    expect(line.actor).toEqual(expect.any(String))
    expect(line.key).toEqual(expect.any(String))
    expect(lines[0]).not.toContain(secret)

    const unknown = await refusals(async () => {
      const response = await SELF.fetch(`${ORIGIN}/_/api/me`, {
        headers: { authorization: 'Bearer dsk_not_a_real_secret' },
      })
      expect(response.status).toBe(401)
    })
    expect(one(unknown)).toMatchObject({ code: 'sign_in_required' })
    expect(unknown[0]).not.toContain('dsk_not_a_real_secret')
  })

  it('logs a stale push with the place it names', async () => {
    const secret = await keySecretFor(owner)
    const lines = await refusals(async () => {
      const response = await SELF.fetch(`${ORIGIN}/_/api/pushes`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          target: `${tree.ws.name}/${tree.name}`,
          baseSeq: 1,
          baseTree: tree.treeId,
          force: false,
          dryRun: false,
          message: null,
          files: [],
        }),
      })
      expect(response.status).toBe(409)
    })
    expect(one(lines)).toMatchObject({
      code: 'stale_head',
      method: 'POST',
      route: '/_/api/pushes',
      path: `${tree.ws.name}/${tree.name}`,
      actor: owner.id,
    })
  })

  it("logs a signed-in person's refused link as them", async () => {
    const lines = await refusals(async () => {
      const response = await outsider.fetch(
        `/${tree.ws.name}/${tree.name}/secret/plan`,
      )
      expect(response.status).toBe(404)
    })
    expect(one(lines)).toMatchObject({
      code: 'not_found',
      route: `/${tree.ws.name}/${tree.name}/secret/plan`,
      actor: outsiderId,
      via: 'browser',
    })
  })

  it('logs a refused frame by its tree and path, never its view handle', async () => {
    const handle = 'A'.repeat(43)
    const lines = await refusals(async () => {
      const response = await new Browser().fetch(
        `/_/v/${handle}/1/secret/plan`,
        { host: `${tree.treeId}.content.test`, purpose: 'none' },
      )
      expect(response.status).toBe(404)
    })
    expect(one(lines)).toMatchObject({
      code: 'not_found',
      route: '/_/v',
      tree: tree.treeId,
      path: 'secret/plan',
    })
    expect(lines[0]).not.toContain(handle)
  })

  it("logs a screen's refused read as the person who asked", async () => {
    const lines = await refusals(async () => {
      await outsider.fetch(REFUSING_SCREEN)
    })
    expect(one(lines)).toMatchObject({
      code: 'forbidden',
      route: REFUSING_SCREEN,
      path: 'acme/plan.html',
      actor: outsiderId,
      via: 'browser',
    })
  })

  it('logs nothing for a request that is answered', async () => {
    const lines = await refusals(async () => {
      const response = await outsider.fetch('/_/api/me', { purpose: 'read' })
      expect(response.status).toBe(200)
    })
    expect(lines).toEqual([])
  })
})
