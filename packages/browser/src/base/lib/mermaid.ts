// Mermaid diagrams written as `<pre class="mermaid">`. The diagram follows
// the page: Mermaid's dark theme when the page shows dark, and the tree's
// --font-body when it sets one. The source stays in data-dossier-source.
import mermaid from 'mermaid'

import type { LibraryContext } from '../../page-client/libraries.ts'
import { isDark, themeVariable } from '../styles.ts'

export const render = async (
  elements: readonly Element[],
  context: LibraryContext,
): Promise<void> => {
  const { window } = context
  const first = elements[0]
  if (first === undefined) return
  const font = themeVariable(window, first, '--font-body')
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: isDark(window, first) ? 'dark' : 'default',
    ...(font === null ? {} : { fontFamily: font }),
  })
  for (const element of elements) {
    element.setAttribute('data-dossier-source', element.textContent ?? '')
  }
  await mermaid.run({
    nodes: elements as unknown as ArrayLike<HTMLElement>,
    suppressErrors: true,
  })
}
