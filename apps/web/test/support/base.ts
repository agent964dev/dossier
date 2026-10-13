// A base layer for tests, with the real base layout and three base components.
import type { BaseLibraries } from '@dossier/contracts'

import layout from '../../../../packages/browser/src/base/_layout.html?raw'

import {
  BaseLayerFrom,
  PageCacheMemory,
  type BaseManifest,
} from '../../src/core/index.ts'
import { testRuntime } from './harness.ts'

export const BASE_LAYOUT: string = layout

const JS = 'text/javascript; charset=utf-8'

/** What the test base layer's dossier-copy.md says. */
export const BASE_COPY_DOC =
  'Copies the page for an agent.\n\nPut `<dossier-copy>` where readers look.\n'

/** Stand-in paths, in the shape the browser build writes. */
const LIBRARIES: BaseLibraries = {
  libraries: {
    mermaid: { live: 'lib/mermaid.js', export: 'lib/mermaid.export.js' },
    shiki: {
      live: 'lib/shiki.js',
      export: 'lib/shiki.export.js',
      grammars: {
        ts: { file: 'lib/shiki-grammars/typescript.json', embedded: [] },
      },
    },
    katex: {
      live: 'lib/katex.js',
      export: 'lib/katex.export.js',
      css: 'lib/katex/katex.css',
      exportCss: 'lib/katex.export.css',
    },
  },
  components: {
    'dossier-diff': {
      live: '_components/dossier-diff.js',
      export: '_components/dossier-diff.export.js',
      doc: '_components/dossier-diff.md',
    },
    'dossier-copy': {
      live: '_components/dossier-copy.js',
      export: '_components/dossier-copy.export.js',
      doc: '_components/dossier-copy.md',
    },
    'dossier-comments': {
      live: '_components/dossier-comments.js',
      export: '_components/dossier-comments.export.js',
      doc: '_components/dossier-comments.md',
    },
  },
}

const typeOf = (path: string) =>
  path.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : path.endsWith('.md')
      ? 'text/markdown; charset=utf-8'
      : JS

/**
 * A base layer at `version` holding dossier-probe and dossier-copy (with
 * their documentation) and dossier-diff (without), and dossier-diff's export
 * build, which is not a component.
 */
export const testBase = (version = 'base0000test') => {
  const sources: Record<string, string> = {
    'shell.js': '// shell',
    'client.js': '// client',
    '_layout.html': layout,
    'lib/mermaid.js': '// mermaid',
    '_components/dossier-probe.js': '// the base dossier-probe',
    '_components/dossier-probe.md': 'The base probe.\n',
    '_components/dossier-copy.js': '// the base dossier-copy',
    '_components/dossier-copy.md': BASE_COPY_DOC,
    '_components/dossier-diff.js': '// the base dossier-diff',
    '_components/dossier-diff.export.js': '// dossier-diff in one file',
  }
  const manifest: BaseManifest = {
    version,
    files: Object.fromEntries(
      Object.entries(sources).map(([path, text]) => [
        path,
        { type: typeOf(path), size: new TextEncoder().encode(text).length },
      ]),
    ),
    libraries: LIBRARIES,
  }
  return { manifest, layer: BaseLayerFrom(manifest, sources) }
}

/** A runtime over that base layer with a recording page cache. */
export const kitRuntime = (
  options: { readonly version?: string; readonly env?: Partial<Env> } = {},
) => {
  const base = testBase(options.version)
  const cache = PageCacheMemory()
  const runtime = testRuntime({
    env: options.env,
    overrides: { base: base.layer, pageCache: cache.layer },
  })
  return { runtime, base, cache }
}
