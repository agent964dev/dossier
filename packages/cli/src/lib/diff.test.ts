import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { structuredPatch } from 'diff'
import { describe, expect, it } from 'vitest'
import type { DiffResponse } from '@dossier/contracts'
import { formatUnifiedDiff } from './diff.js'

const response: DiffResponse = {
  ok: true,
  documentId: '7k2m9x1qz3ab',
  from: { versionNumber: 2, createdAt: '2026-09-12T00:00:00Z', fileSize: 20 },
  to: { versionNumber: 4, createdAt: '2026-09-12T00:01:00Z', fileSize: 31 },
  mode: 'html',
  hunks: [
    {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 3,
      lines: [
        { op: ' ', text: '<main>' },
        { op: '-', text: '<p>Before</p>' },
        { op: '+', text: '<p>After</p>' },
        { op: '+', text: '</main>\n' },
      ],
    },
  ],
  stats: { added: 2, removed: 1 },
}

describe('formatUnifiedDiff', () => {
  it('prints standard unified headers, ranges, and line prefixes', () => {
    expect(formatUnifiedDiff(response)).toBe(
      '--- a/7k2m9x1qz3ab@2\n' +
        '+++ b/7k2m9x1qz3ab@4\n' +
        '@@ -1,2 +1,3 @@\n' +
        ' <main>\n' +
        '-<p>Before</p>\n' +
        '+<p>After</p>\n' +
        '+</main>\n',
    )
  })

  it('omits a range count of one and adds color only when requested', () => {
    const oneLine: DiffResponse = {
      ...response,
      hunks: [{ ...response.hunks[0]!, oldLines: 1, newLines: 1 }],
    }
    const escape = String.fromCharCode(27)
    expect(formatUnifiedDiff(oneLine)).not.toContain(`${escape}[`)
    expect(formatUnifiedDiff(oneLine)).toContain('@@ -1 +1 @@')
    expect(formatUnifiedDiff(oneLine, true)).toContain(`${escape}[31m`)
    expect(formatUnifiedDiff(oneLine, true)).toContain(`${escape}[32m`)
  })

  it.each([
    { name: 'pure insertion', before: 'one\ntwo\nthree\n', after: 'one\ntwo\nthree\nfour\n' },
    { name: 'pure deletion', before: 'one\ntwo\nthree\nfour\n', after: 'one\ntwo\nthree\n' },
    { name: 'empty to content', before: '', after: 'one\ntwo\n' },
  ])('matches diff -u hunk headers for $name', ({ before, after }) => {
    const directory = mkdtempSync(join(tmpdir(), 'dossier-unified-diff-'))
    try {
      const oldFile = join(directory, 'before.txt')
      const newFile = join(directory, 'after.txt')
      writeFileSync(oldFile, before)
      writeFileSync(newFile, after)
      // Zero context exposes empty ranges for insertion/deletion hunks.
      const native = spawnSync('diff', ['-u', '-U', '0', oldFile, newFile], {
        encoding: 'utf8',
      })
      expect(native.error).toBeUndefined()
      expect(native.status).toBe(1)
      const patch = structuredPatch(oldFile, newFile, before, after, '', '', { context: 0 })!
      const formatted = formatUnifiedDiff({
        ...response,
        hunks: patch.hunks.map((hunk) => ({
          ...hunk,
          lines: hunk.lines.map((line) => ({
            op: line[0] as ' ' | '+' | '-',
            text: line.slice(1),
          })),
        })),
      })
      const headers = (output: string) => output.split('\n').filter((line) => line.startsWith('@@'))
      expect(headers(native.stdout)).toHaveLength(1)
      expect(headers(formatted)).toEqual(headers(native.stdout))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('prints the conventional marker when a source lacks its final newline', () => {
    const withoutNewline: DiffResponse = {
      ...response,
      hunks: [{
        ...response.hunks[0]!,
        lines: [{ op: '+', text: '<p>final</p>', noNewline: true }],
      }],
    }
    expect(formatUnifiedDiff(withoutNewline)).toContain(
      '+<p>final</p>\n\\ No newline at end of file\n',
    )
  })

  it('escapes uploaded terminal controls on TTYs even when color is disabled', () => {
    const escape = String.fromCharCode(27)
    const bell = String.fromCharCode(7)
    const injected: DiffResponse = {
      ...response,
      hunks: [{
        ...response.hunks[0]!,
        lines: [{ op: '+', text: `safe${escape}]52;c;payload${bell}` }],
      }],
    }
    const terminal = formatUnifiedDiff(injected, false, true)
    expect(terminal).toContain('safe\\x1b]52;c;payload\\x07')
    expect(terminal).not.toContain(escape)
    expect(terminal).not.toContain(bell)
    expect(formatUnifiedDiff(injected, false, false)).toContain(escape)
  })

  it('rejects unknown server operations instead of printing a corrupt patch', () => {
    expect(() =>
      formatUnifiedDiff({
        ...response,
        hunks: [
          {
            ...response.hunks[0]!,
            lines: [{ op: 'mystery' as '+', text: 'line' }],
          },
        ],
      }),
    ).toThrow('unsupported diff operation')
  })
})
