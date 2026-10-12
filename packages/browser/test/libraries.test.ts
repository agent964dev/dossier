// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  libraryUrl,
  startLibraries,
  type LibraryModule,
  type LibraryName,
} from '../src/page-client/libraries.ts'
import { installLibraries } from '../src/page-client/install.ts'
import type { PageBootstrap } from '@dossier/contracts/bridge'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

const BASE = '/_/base/b1'
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A loader whose libraries record what they were asked to render. */
const loader = (failing: readonly LibraryName[] = []) => {
  const rendered: Record<string, Element[][]> = {}
  const failures: string[] = []
  const importLibrary = vi.fn(async (name: LibraryName) => {
    if (failing.includes(name)) throw new Error('blocked')
    return {
      render: async (elements: readonly Element[]) => {
        ;(rendered[name] ??= []).push([...elements])
      },
    } satisfies LibraryModule
  })
  const libraries = startLibraries({
    base: BASE,
    window,
    reportFailure: (url) => failures.push(url),
    importLibrary,
  })
  return { libraries, importLibrary, rendered, failures }
}

const page = (html: string) => {
  document.body.innerHTML = html
  return document.body
}

describe('the library loader', () => {
  test('imports nothing when the page holds no library markup', async () => {
    const { libraries, importLibrary } = loader()
    libraries.scan(
      page(
        '<pre>plain</pre><code class="language-ts">x</code><p class="math">x</p>',
      ),
    )
    await settle()
    expect(importLibrary).not.toHaveBeenCalled()
  })

  test('imports each library once per page, for markup found now and later', async () => {
    const { libraries, importLibrary, rendered } = loader()
    const body = page(
      '<pre class="mermaid">graph TD; A-->B</pre>' +
        '<pre><code class="language-ts">let a = 1</code></pre>' +
        '<span class="math inline">x</span><div class="math display">y</div>',
    )
    libraries.scan(body)
    await settle()
    const later = document.createElement('pre')
    later.className = 'mermaid'
    later.textContent = 'graph LR; C-->D'
    body.append(later)
    libraries.scan(later)
    libraries.scan(body)
    await settle()
    expect(importLibrary.mock.calls.map(([name]) => name).sort()).toEqual([
      'katex',
      'mermaid',
      'shiki',
    ])
    expect(rendered.mermaid?.map((batch) => batch.length)).toEqual([1, 1])
    expect(rendered.mermaid?.[1]?.[0]).toBe(later)
    expect(rendered.katex?.[0]?.length).toBe(2)
    expect(rendered.shiki?.[0]?.[0]?.tagName).toBe('CODE')
  })

  test('skips markup that already holds elements or was processed by the page', async () => {
    const { libraries, importLibrary } = loader()
    libraries.scan(
      page(
        '<pre class="mermaid"><svg></svg></pre>' +
          '<pre><code class="language-ts" data-processed>x</code></pre>' +
          '<span class="math inline"><span class="MathJax">x</span></span>',
      ),
    )
    await settle()
    expect(importLibrary).not.toHaveBeenCalled()
  })

  test('reports a library that fails to load once, and leaves its markup as written', async () => {
    const { libraries, failures, importLibrary } = loader(['mermaid'])
    const body = page('<pre class="mermaid"></pre><pre class="mermaid">x</pre>')
    body.firstElementChild!.textContent = 'graph TD; A-->B'
    libraries.scan(body)
    await settle()
    const more = document.createElement('pre')
    more.className = 'mermaid'
    body.append(more)
    libraries.scan(more)
    await settle()
    expect(importLibrary).toHaveBeenCalledTimes(1)
    expect(failures).toEqual([libraryUrl(BASE, 'mermaid')])
    expect([...body.children].map((pre) => pre.textContent)).toEqual([
      'graph TD; A-->B',
      'x',
      '',
    ])
    expect(body.querySelector('svg')).toBeNull()
  })
})

describe('the page client starting the loader', () => {
  const bootstrap = { base: 'b1' } as PageBootstrap

  test('logs one console line naming the file when a library cannot be imported', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    page(
      '<pre class="mermaid">graph TD; A-->B</pre><pre class="mermaid">x</pre>',
    )
    installLibraries(window, bootstrap)
    // The import of /_/base/b1/lib/mermaid.js fails: nothing serves it here.
    await vi.waitFor(() => expect(errors).toHaveBeenCalled())
    await settle()
    expect(errors.mock.calls).toEqual([
      ['dossier: could not load /_/base/b1/lib/mermaid.js'],
    ])
    expect(document.querySelectorAll('pre.mermaid svg')).toHaveLength(0)
  })

  test('imports no library for a page without its markup', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    page('<h1>Plain</h1><pre>code</pre>')
    installLibraries(window, bootstrap)
    await settle()
    await settle()
    expect(errors).not.toHaveBeenCalled()
  })
})
