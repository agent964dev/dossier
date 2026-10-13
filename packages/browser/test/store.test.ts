import { VISITOR_VIEWER, type PendingSend } from '@dossier/contracts/bridge'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, test } from 'vitest'
import { browserStore } from '../src/shell/store.ts'

const PAGE = 'questions/index.html'

const pending = (
  opId: string,
  savedAt: string,
  entries: PendingSend['entries'] = [['name', 'Sara']],
  by: string | null = 'sara@acme.com',
): PendingSend => ({
  form: { host: 'n1', target: 'questions/answers/', id: null },
  seq: 7,
  entries,
  submitter: null,
  opId,
  page: PAGE,
  by,
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
    await store.saveDraft(VISITOR_VIEWER, 't1', PAGE, 'a', { name: 'Visitor' })
    expect(await store.loadDrafts('sara@acme.com', 't1', PAGE)).toEqual({
      a: { name: 'Sa' },
      b: { tags: ['x', 'y'] },
    })
    expect(await store.loadDrafts(VISITOR_VIEWER, 't1', PAGE)).toEqual({
      a: { name: 'Visitor' },
    })
    await store.saveDraft('sara@acme.com', 't1', PAGE, 'a', null)
    expect(await store.loadDrafts('sara@acme.com', 't1', PAGE)).toEqual({
      b: { tags: ['x', 'y'] },
    })
    expect(await store.loadDrafts('omar@acme.com', 't1', PAGE)).toEqual({})
  })

  test('hands the visitor’s drafts and sends in a tree to the person', async () => {
    const store = browserStore(new IDBFactory())
    await store.saveDraft(VISITOR_VIEWER, 't1', PAGE, 'a', { name: 'Visitor' })
    await store.saveDraft(VISITOR_VIEWER, 't1', PAGE, 'b', { x: 'V' })
    await store.saveDraft(VISITOR_VIEWER, 't1', 'plan.html', 'b', { x: '1' })
    await store.saveDraft(VISITOR_VIEWER, 't2', PAGE, 'a', { name: 'Other' })
    await store.saveDraft('sara@acme.com', 't1', PAGE, 'a', { name: 'Own' })
    const at = '2026-10-12T10:00:00.000Z'
    await store.savePending('t1', PAGE, pending('visitor', at, undefined, null))
    await store.savePending('t1', PAGE, pending('omar', at, undefined, 'omar'))
    await store.savePending('t2', PAGE, pending('away', at, undefined, null))

    await store.claimVisitor('sara@acme.com', 't1')
    // The person's own draft of a form stays; the visitor's other forms move.
    expect(await store.loadDrafts('sara@acme.com', 't1', PAGE)).toEqual({
      a: { name: 'Own' },
      b: { x: 'V' },
    })
    expect(await store.loadDrafts('sara@acme.com', 't1', 'plan.html')).toEqual({
      b: { x: '1' },
    })
    expect(await store.loadDrafts(VISITOR_VIEWER, 't1', PAGE)).toEqual({})
    expect(await store.loadDrafts(VISITOR_VIEWER, 't1', 'plan.html')).toEqual(
      {},
    )
    expect(await store.loadDrafts(VISITOR_VIEWER, 't2', PAGE)).toEqual({
      a: { name: 'Other' },
    })
    const kept = await store.loadPending('t1', PAGE)
    expect(kept.map((send) => [send.opId, send.by])).toEqual([
      ['omar', 'omar'],
      ['visitor', 'sara@acme.com'],
    ])
    expect((await store.loadPending('t2', PAGE))[0]!.by).toBeNull()
  })

  test('the visitor claims nothing from itself', async () => {
    const store = browserStore(new IDBFactory())
    await store.saveDraft(VISITOR_VIEWER, 't1', PAGE, 'a', { name: 'V' })
    await store.savePending(
      't1',
      PAGE,
      pending('visitor', '2026-10-12T10:00:00.000Z', undefined, null),
    )
    await store.claimVisitor(VISITOR_VIEWER, 't1')
    expect(await store.loadDrafts(VISITOR_VIEWER, 't1', PAGE)).toEqual({
      a: { name: 'V' },
    })
    expect((await store.loadPending('t1', PAGE))[0]!.by).toBeNull()
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
    await browserStore(factory).saveDraft(VISITOR_VIEWER, 't1', PAGE, 'a', {
      n: '1',
    })
    expect(
      await browserStore(factory).loadDrafts(VISITOR_VIEWER, 't1', PAGE),
    ).toEqual({
      a: { n: '1' },
    })
  })
})
