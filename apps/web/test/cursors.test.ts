import type { TreeId } from '@dossier/contracts'
import { describe, expect, it } from 'vitest'

import { openCursor, sealCursor } from '../src/core/cursors.ts'

const SECRET = 'cursor-test-secret-0123456789abcdef'
const TREE = 'abcdefghij0123456789' as TreeId
const OTHER = 'zyxwvutsrq9876543210' as TreeId

describe('event cursors', () => {
  it('have one length and alphabet whatever the position', async () => {
    for (const seq of [0, 7, 500, 2 ** 40]) {
      const cursor = await sealCursor(SECRET, TREE, seq, 'person-1')
      expect(cursor).toMatch(/^[A-Za-z0-9_-]{118}$/)
    }
  })

  it('differ each time for one position, and open to it', async () => {
    const a = await sealCursor(SECRET, TREE, 42, 'person-1')
    const b = await sealCursor(SECRET, TREE, 42, 'person-1')
    expect(a).not.toBe(b)
    expect(await openCursor(SECRET, TREE, a, 'person-1')).toBe(42)
    expect(await openCursor(SECRET, TREE, b, 'person-1')).toBe(42)
  })

  it('open only for their tree, their caller and the deployment secret', async () => {
    const cursor = await sealCursor(SECRET, TREE, 42, 'person-1')
    expect(await openCursor(SECRET, OTHER, cursor, 'person-1')).toBeNull()
    expect(await openCursor(SECRET, TREE, cursor, 'person-2')).toBeNull()
    expect(await openCursor(SECRET, TREE, cursor, '')).toBeNull()
    expect(await openCursor(`${SECRET}x`, TREE, cursor, 'person-1')).toBeNull()
  })

  it('refuse any change to a single character, and any other length', async () => {
    const cursor = await sealCursor(SECRET, TREE, 42, 'person-1')
    for (let i = 0; i < cursor.length; i += 1) {
      const swapped = cursor[i] === 'A' ? 'B' : 'A'
      const tampered = `${cursor.slice(0, i)}${swapped}${cursor.slice(i + 1)}`
      expect(
        await openCursor(SECRET, TREE, tampered, 'person-1'),
        `${i}`,
      ).toBeNull()
    }
    for (const bad of ['', '42', cursor.slice(1), `${cursor}A`, '!!!']) {
      expect(await openCursor(SECRET, TREE, bad, 'person-1')).toBeNull()
    }
  })
})
