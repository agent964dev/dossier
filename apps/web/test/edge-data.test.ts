import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Browser, signedIn } from './support/browser.ts'
import {
  formRef,
  pushForms,
  QUESTIONS,
  type FormTree,
} from './support/forms.ts'
import { harness } from './support/harness.ts'
import { callerOf, fresh } from './support/people.ts'
import {
  join,
  nodeAt,
  person,
  sha256Of,
  share,
  workspace,
} from './support/trees.ts'

afterEach(() => harness.reset())

let browser: Browser
let ws: { id: string; name: string }
let tree: FormTree
let form: { host: string; target: string; id: string | null }

beforeAll(async () => {
  browser = await signedIn(fresh())
  const owner = (await callerOf(browser)).person!
  ws = await workspace(owner)
  tree = await pushForms(owner, ws, { 'questions/index.html': QUESTIONS })
  form = await formRef(tree, 'questions/index.html', 'questions/answers/')
})

const sendBody = (opId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    tree: tree.treeId,
    page: 'questions/index.html',
    seq: 1,
    form,
    entries: [['role', 'Designer']],
    submitter: null,
    entry: null,
    opId,
    ...extra,
  })

describe('the data endpoints', () => {
  it('send, upload, read and withdraw, each as the viewer', async () => {
    const opId = crypto.randomUUID()
    const sent = await browser.fetch('/_/api/data/send', {
      method: 'POST',
      purpose: 'write',
      headers: { 'content-type': 'application/json' },
      body: sendBody(opId),
    })
    expect(sent.status).toBe(200)
    const result = (await sent.json()) as {
      doc: { path: string; data: unknown }
      replayed: boolean
    }
    expect(result.replayed).toBe(false)
    expect(result.doc.data).toEqual({ role: 'Designer', regions: [] })

    const bytes = '%PDF-1.7 cv'
    const params = new URLSearchParams({
      tree: tree.treeId,
      page: 'questions/index.html',
      seq: '1',
      host: form.host,
      target: form.target,
      field: 'cv',
      name: 'cv.pdf',
      type: 'application/pdf',
      size: String(bytes.length),
      sha256: await sha256Of(bytes),
      opId: `${opId}:cv`,
    })
    const uploaded = await browser.fetch(`/_/api/data/upload?${params}`, {
      method: 'PUT',
      purpose: 'write',
      headers: { 'content-length': String(bytes.length) },
      body: bytes,
    })
    expect(uploaded.status).toBe(201)
    expect(await uploaded.json()).toMatchObject({
      file: 'files/cv.pdf',
      name: 'cv.pdf',
    })

    const read = await browser.fetch(
      `/_/api/data/read?tree=${tree.treeId}&path=${encodeURIComponent('questions/answers/')}`,
      { purpose: 'read' },
    )
    expect(read.status).toBe(200)
    const files = ((await read.json()) as { files: { path: string }[] }).files
    expect(files.map((f) => f.path)).toEqual([
      result.doc.path,
      expect.stringMatching(/files\/cv\.pdf$/),
    ])
    const missing = await browser.fetch(
      `/_/api/data/read?tree=${tree.treeId}&path=nothing.json`,
      { purpose: 'read' },
    )
    expect(await missing.json()).toEqual({ file: null })

    const withdrawn = await browser.fetch('/_/api/data/withdraw', {
      method: 'POST',
      purpose: 'write',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tree: tree.treeId,
        path: result.doc.path,
        opId: crypto.randomUUID(),
      }),
    })
    expect(withdrawn.status).toBe(204)
  })

  it('answers a send without the CSRF header as signed out', async () => {
    const response = await browser.fetch('/_/api/data/send', {
      method: 'POST',
      purpose: 'write',
      headers: { 'content-type': 'application/json', 'dossier-csrf': '0' },
      body: sendBody(crypto.randomUUID()),
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { code: 'sign_in_required' },
    })
  })

  it('answers whom to mention for a member, and nobody alike for a visitor and a missing page', async () => {
    const owner = (await callerOf(browser)).person!
    const lena = await person('lena')
    await join(ws, lena)
    await share(
      tree.treeId,
      (await nodeAt(tree.treeId, ''))!.id,
      'workspace',
      ws.id,
      'read',
      owner,
    )
    const ask = (who: Browser, page: string) =>
      who.fetch(
        `/_/api/data/mentionable?${new URLSearchParams({ tree: tree.treeId, page, q: 'len' })}`,
        { purpose: 'read' },
      )
    const found = await ask(browser, 'questions/index.html')
    expect(found.status).toBe(200)
    expect(await found.json()).toEqual({
      people: [{ email: lena.email.toLowerCase(), name: 'lena', image: null }],
      teams: [],
    })
    const nobody = { people: [], teams: [] }
    for (const [who, page] of [
      [new Browser(), 'questions/index.html'],
      [browser, 'missing.html'],
    ] as const) {
      const response = await ask(who, page)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(nobody)
    }
  })

  it('answers a visitor’s read with nothing, never not_found', async () => {
    const response = await new Browser().fetch(
      `/_/api/data/read?tree=${tree.treeId}&path=${encodeURIComponent('questions/answers/')}`,
      { purpose: 'read' },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ files: [] })
  })

  it('writes page code data, and uploads beside the page, as the viewer', async () => {
    const body = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        tree: tree.treeId,
        page: 'questions/index.html',
        path: 'layout.json',
        patch: { n1: { x: 1, y: 2 } },
        replace: false,
        opId: crypto.randomUUID(),
        seq: 1,
        ...extra,
      })
    const written = await browser.fetch('/_/api/data/write', {
      method: 'POST',
      purpose: 'write',
      headers: { 'content-type': 'application/json' },
      body: body(),
    })
    expect(written.status).toBe(200)
    expect(await written.json()).toMatchObject({
      path: 'layout.json',
      data: { n1: { x: 1, y: 2 } },
      push: 1,
    })
    const unsigned = await browser.fetch('/_/api/data/write', {
      method: 'POST',
      purpose: 'write',
      headers: { 'content-type': 'application/json', 'dossier-csrf': '0' },
      body: body(),
    })
    expect(unsigned.status).toBe(401)
    expect(await unsigned.json()).toMatchObject({
      error: { code: 'sign_in_required' },
    })

    const bytes = 'a picture'
    const email = (await callerOf(browser)).person!.email.toLowerCase()
    const params = new URLSearchParams({
      tree: tree.treeId,
      page: 'questions/index.html',
      seq: '1',
      name: 'photo.png',
      type: 'image/png',
      size: String(bytes.length),
      sha256: await sha256Of(bytes),
      opId: crypto.randomUUID(),
    })
    const uploaded = await browser.fetch(`/_/api/data/upload?${params}`, {
      method: 'PUT',
      purpose: 'write',
      headers: { 'content-length': String(bytes.length) },
      body: bytes,
    })
    expect(uploaded.status).toBe(201)
    expect(await uploaded.json()).toEqual({
      path: `questions/index.uploads/${email}/photo.png`,
      file: 'photo.png',
      name: 'photo.png',
      size: bytes.length,
      type: 'image/png',
    })
  })

  it('answers the events of a tree to its viewer, from a cursor', async () => {
    const start = await browser.fetch(`/_/api/events?tree=${tree.treeId}`, {
      purpose: 'read',
    })
    expect(start.status).toBe(200)
    const { next } = (await start.json()) as { next: string }
    await browser.fetch('/_/api/data/write', {
      method: 'POST',
      purpose: 'write',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tree: tree.treeId,
        page: 'questions/index.html',
        path: 'events-check.json',
        patch: { a: 1 },
        replace: false,
        opId: crypto.randomUUID(),
        seq: 1,
      }),
    })
    const since = await browser.fetch(
      `/_/api/events?tree=${tree.treeId}&after=${encodeURIComponent(next)}`,
      { purpose: 'read' },
    )
    expect(since.status).toBe(200)
    expect(await since.json()).toMatchObject({
      events: [{ type: 'data_write', path: 'events-check.json' }],
      more: false,
    })
  })

  it('asks an anonymous caller to sign in before it reads the body of a write', async () => {
    for (const path of [
      '/_/api/data/write',
      '/_/api/data/send',
      '/_/api/data/withdraw',
      '/_/api/pushes',
    ]) {
      const response = await new Browser().fetch(path, {
        method: 'POST',
        purpose: 'none',
        headers: {
          origin: 'https://abcdefghij0123456789.content.test',
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'cors',
        },
      })
      expect(response.status, path).toBe(401)
      expect(await response.json(), path).toMatchObject({
        error: { code: 'sign_in_required' },
      })
    }
    // The CLI's device login is a write that needs no one signed in.
    const device = await new Browser().fetch('/_/api/device/token', {
      method: 'POST',
      purpose: 'none',
    })
    expect(device.status).toBe(400)
  })
})
