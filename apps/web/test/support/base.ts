// A base layer for tests, with the real base layout and two base components.
import layout from '../../../../packages/browser/src/base/_layout.html?raw'

import {
  BaseLayerFrom,
  PageCacheMemory,
  type BaseManifest,
} from '../../src/core/index.ts'
import { testRuntime } from './harness.ts'

export const BASE_LAYOUT: string = layout

const JS = 'text/javascript; charset=utf-8'

/** A base layer at `version` holding dossier-probe and dossier-copy. */
export const testBase = (version = 'base0000test') => {
  const sources: Record<string, string> = {
    'shell.js': '// shell',
    'client.js': '// client',
    '_layout.html': layout,
    '_components/dossier-probe.js': '// the base dossier-probe',
    '_components/dossier-copy.js': '// the base dossier-copy',
  }
  const manifest: BaseManifest = {
    version,
    files: Object.fromEntries(
      Object.entries(sources).map(([path, text]) => [
        path,
        {
          type: path.endsWith('.html') ? 'text/html; charset=utf-8' : JS,
          size: new TextEncoder().encode(text).length,
        },
      ]),
    ),
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
