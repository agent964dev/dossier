import { describe, expect, test } from 'vitest'

import { analyzeJs, JS_ANALYZER_VERSION, rewriteImports } from '../src/index.ts'
import { fixture, slicer } from './helpers.ts'

describe('analyzeJs', () => {
  const source = fixture('export/module.js')
  const expected = JSON.parse(fixture('export/module.expected.json')) as {
    specifier: string
    text: string
    dynamic: boolean
  }[]

  test('finds static imports, re-exports, side-effect and literal dynamic imports', () => {
    const analysis = analyzeJs(source)
    const text = slicer(source)
    expect(analysis.v).toBe(JS_ANALYZER_VERSION)
    expect(
      analysis.imports.map((found) => ({
        specifier: found.specifier,
        text: text(found.range),
        dynamic: found.dynamic,
      })),
    ).toEqual(expected)
  })

  test('ignores the word import in strings and comments, and computed imports', () => {
    const specifiers = analyzeJs(source).imports.map((found) => found.specifier)
    for (const absent of [
      './not-a-module.js',
      './not-either.js',
      './commented.js',
      './block.js',
    ]) {
      expect(specifiers).not.toContain(absent)
    }
    expect(specifiers.some((s) => s.startsWith('./${'))).toBe(false)
  })

  test('answers no imports for a source that does not parse', () => {
    expect(analyzeJs('import { from "./a.js"').imports).toEqual([])
  })
})

describe('rewriteImports', () => {
  test('changes only the specifiers it renames, inside their own quotes', () => {
    const source = fixture('export/module.js')
    const { imports } = analyzeJs(source)
    const out = rewriteImports(source, imports, (specifier) =>
      specifier.startsWith('./') && specifier !== './all.js'
        ? `dossier-export/${specifier.slice(2)}`
        : null,
    )
    // Everything but the renamed specifiers is the source byte for byte.
    let rebuilt = source
    for (const found of [...imports].reverse()) {
      if (!found.specifier.startsWith('./') || found.specifier === './all.js') {
        continue
      }
      rebuilt =
        rebuilt.slice(0, found.range.start) +
        `dossier-export/${found.specifier.slice(2)}` +
        rebuilt.slice(found.range.end)
    }
    expect(out).toBe(rebuilt)
    expect(out).toContain("import shared from 'dossier-export/shared.js'")
    expect(out).toContain('import { a, b as c } from "../lib/util.js"')
    expect(out).toContain("import * as all from './all.js'")
    expect(out).toContain("import('dossier-export/lazy.js')")
    expect(out).toContain('import(`dossier-export/template.js`)')
    expect(out).toContain("import esc from 'dossier-export/escaped.js'")
    expect(analyzeJs(out).imports.map((found) => found.specifier)).toContain(
      'dossier-export/side-effect.js',
    )
  })

  test('escapes a name for the quotes it sits in', () => {
    const source = `import a from "./a.js"\nimport b from './b.js'\nimport(\`./c.js\`)`
    const out = rewriteImports(source, analyzeJs(source).imports, (s) =>
      s === './a.js' ? 'x"y' : s === './b.js' ? "x'y" : 'x${y}',
    )
    expect(out).toBe(
      'import a from "x\\u0022y"\nimport b from \'x\\u0027y\'\nimport(`x\\${y}`)',
    )
    expect(analyzeJs(out).imports.map((found) => found.specifier)).toEqual([
      'x"y',
      "x'y",
    ])
  })
})
