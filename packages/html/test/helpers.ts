import { readFileSync } from 'node:fs'
import type { Range } from '../src/index.ts'

/** A fixture page as written, with LF line endings. */
export const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

/** The same page saved with Windows line endings. */
export const crlf = (source: string): string =>
  source.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')

/** What a range holds: tests read ranges as the text they cover. */
export const slicer =
  (source: string) =>
  (range: Range | null): string | null =>
    range === null ? null : source.slice(range.start, range.end)
