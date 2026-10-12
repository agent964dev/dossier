import type { Json, JsonObject } from '@dossier/contracts/bridge'
import { describe, expect, test } from 'vitest'
import {
  applyMergePatch,
  composeMergePatch,
} from '../src/page-client/merge-patch.ts'

describe('applyMergePatch', () => {
  // RFC 7396, Appendix A.
  test.each<[Json, Json, Json]>([
    [{ a: 'b' }, { a: 'c' }, { a: 'c' }],
    [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }],
    [{ a: 'b' }, { a: null }, {}],
    [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }],
    [{ a: ['b'] }, { a: 'c' }, { a: 'c' }],
    [{ a: 'c' }, { a: ['b'] }, { a: ['b'] }],
    [{ a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }],
    [{ a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }],
    [
      ['a', 'b'],
      ['c', 'd'],
      ['c', 'd'],
    ],
    [{ a: 'b' }, ['c'], ['c']],
    [{ a: 'foo' }, null, null],
    [{ a: 'foo' }, 'bar', 'bar'],
    [{ e: null }, { a: 1 }, { e: null, a: 1 }],
    [[1, 2], { a: 'b', c: null }, { a: 'b' }],
    [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
  ])('%j patched with %j is %j', (target, patch, result) => {
    expect(applyMergePatch(target, patch)).toEqual(result)
  })

  test('the example of section 3', () => {
    const target: Json = {
      title: 'Goodbye!',
      author: { givenName: 'John', familyName: 'Doe' },
      tags: ['example', 'sample'],
      content: 'This will be unchanged',
    }
    const patch: Json = {
      title: 'Hello!',
      phoneNumber: '+01-123-456-7890',
      author: { familyName: null },
      tags: ['example'],
    }
    expect(applyMergePatch(target, patch)).toEqual({
      title: 'Hello!',
      author: { givenName: 'John' },
      tags: ['example'],
      content: 'This will be unchanged',
      phoneNumber: '+01-123-456-7890',
    })
  })

  test('changes neither argument, and keeps __proto__ a plain key', () => {
    const target = { a: { b: 1 } }
    const patch = JSON.parse('{"a":{"c":2},"__proto__":{"x":1}}') as Json
    const result = applyMergePatch(target, patch) as Record<string, unknown>
    expect(target).toEqual({ a: { b: 1 } })
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(Object.hasOwn(result, '__proto__')).toBe(true)
    expect(result.a).toEqual({ b: 1, c: 2 })
  })
})

/** A seeded generator (mulberry32), so a failure can be run again. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const KEYS = ['a', 'b', 'c']

const json = (next: () => number, depth: number): Json => {
  const roll = next()
  if (depth > 0 && roll < 0.45) return object(next, depth - 1)
  if (roll < 0.6) return null
  if (roll < 0.75) return Math.floor(next() * 3)
  if (roll < 0.88) return ['x', 'y', 'z'][Math.floor(next() * 3)]!
  return [Math.floor(next() * 3)]
}

const object = (next: () => number, depth: number): JsonObject => {
  const out: Record<string, Json> = {}
  for (const key of KEYS) {
    if (next() < 0.55) out[key] = json(next, depth)
  }
  return out as JsonObject
}

describe('composeMergePatch', () => {
  test('applying it equals applying the first, then the second', () => {
    const next = random(7396)
    let composed = 0
    let refused = 0
    for (let i = 0; i < 5000; i++) {
      const first = object(next, 3)
      const then = object(next, 3)
      const both = composeMergePatch(first, then)
      if (both === null) {
        refused += 1
        continue
      }
      composed += 1
      for (let j = 0; j < 4; j++) {
        const target = json(next, 3)
        expect(applyMergePatch(target, both)).toEqual(
          applyMergePatch(applyMergePatch(target, first), then),
        )
      }
    }
    // Both outcomes are exercised.
    expect(composed).toBeGreaterThan(1000)
    expect(refused).toBeGreaterThan(100)
  })

  test('null, then an object under the same key, has no single patch', () => {
    expect(composeMergePatch({ a: null }, { a: { new: 2 } })).toBeNull()
    expect(composeMergePatch({ a: 1 }, { a: { new: 2 } })).toBeNull()
    expect(composeMergePatch({ a: { b: null } }, { a: { b: { c: 1 } } })).toBe(
      null,
    )
  })

  test('merges objects at every depth and lets the later value win', () => {
    expect(
      composeMergePatch(
        { a: { b: 1, c: null }, d: 'x' },
        { a: { c: 2 }, d: null, e: { f: 1 } },
      ),
    ).toEqual({ a: { b: 1, c: 2 }, d: null, e: { f: 1 } })
  })
})
