import type { PendingSend } from '@dossier/contracts/bridge'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, test } from 'vitest'
import { browserStore } from '../src/shell/store.ts'

const PAGE = 'questions/index.html'

const pending = (
  opId: string,
  savedAt: string,
  entries: PendingSend['entries'] = [['name', 'Sara']],
): PendingSend => ({
  form: { host: 'n1', target: 'questions/answers/', id: null },
  seq: 7,
  entries,
  submitter: null,
  opId,
  page: PAGE,
  by: 'sara@acme.com',
  savedAt,
})

describe('browserStore', () => {
  test('keeps drafts per viewer, tree, page and form', async () => {
    const store = browserStore(new IDBFactory())
    await store.saveDraft('sara@acme.com', 't1', PAGE, 'a', { name: 'Sa' })
    await store.saveDraft('sara@acme.com', 't1', PAGE, 'b', {
      tags: ['x', 'y'],
    })
    await store.saveDraft('sara@acme.com', 't1', 'plan.html', 'a', {
      name: 'P',
    })
    await store.saveDraft('sara@acme.com', 't2', PAGE, 'a', { name: 'T2' })
    await store.saveDraft('', 't1', PAGE, 'a', { name: 'Visitor' })
    expect(await store.loadDrafts('sara@acme.com', 't1', PAGE)).toEqual({
      a: { name: 'Sa' },
      b: { tags: ['x', 'y'] },
    })
    expect(await store.loadDrafts('', 't1', PAGE)).toEqual({
      a: { name: 'Visitor' },
    })
    await store.saveDraft('sara@acme.com', 't1', PAGE, 'a', null)
    expect(await store.loadDrafts('sara@acme.com', 't1', PAGE)).toEqual({
      b: { tags: ['x', 'y'] },
    })
    expect(await store.loadDrafts('omar@acme.com', 't1', PAGE)).toEqual({})
  })

  test('hands one viewer’s drafts in a tree to another', async () => {
    const store = browserStore(new IDBFactory())
    await store.saveDraft('', 't1', PAGE, 'a', { name: 'Visitor' })
    await store.saveDraft('', 't1', 'plan.html', 'b', { x: '1' })
    await store.saveDraft('', 't2', PAGE, 'a', { name: 'Other tree' })
    await store.saveDraft('sara@acme.com', 't1', PAGE, 'a', { name: 'Old' })
    await store.adoptDrafts('', 'sara@acme.com', 't1')
    expect(await store.loadDrafts('sara@acme.com', 't1', PAGE)).toEqual({
      a: { name: 'Visitor' },
    })
    expect(await store.loadDrafts('sara@acme.com', 't1', 'plan.html')).toEqual({
      b: { x: '1' },
    })
    expect(await store.loadDrafts('', 't1', PAGE)).toEqual({})
    expect(await store.loadDrafts('', 't2', PAGE)).toEqual({
      a: { name: 'Other tree' },
    })
  })

  test('keeps sends per tree and page, oldest first, with their files', async () => {
    const store = browserStore(new IDBFactory())
    const file = new File(['%PDF'], 'cv.pdf', { type: 'application/pdf' })
    await store.savePending(
      't1',
      PAGE,
      pending('later', '2026-10-12T11:00:00.000Z', [['cv', file]]),
    )
    await store.savePending(
      't1',
      PAGE,
      pending('first', '2026-10-12T10:00:00.000Z'),
    )
    await store.savePending(
      't1',
      'plan.html',
      pending('elsewhere', '2026-10-12T09:00:00.000Z'),
    )
    const kept = await store.loadPending('t1', PAGE)
    expect(kept.map((send) => send.opId)).toEqual(['first', 'later'])
    const stored = kept[1]!.entries[0]![1] as File
    expect(stored).toBeInstanceOf(Blob)
    expect(stored.name).toBe('cv.pdf')
    expect(await stored.text()).toBe('%PDF')
    await store.clearPending('t1', PAGE, 'first')
    expect((await store.loadPending('t1', PAGE)).map((s) => s.opId)).toEqual([
      'later',
    ])
    expect(await store.loadPending('t2', PAGE)).toEqual([])
  })

  test('a fresh store opens the same database again', async () => {
    const factory = new IDBFactory()
    await browserStore(factory).saveDraft('', 't1', PAGE, 'a', { n: '1' })
    expect(await browserStore(factory).loadDrafts('', 't1', PAGE)).toEqual({
      a: { n: '1' },
    })
  })
})
