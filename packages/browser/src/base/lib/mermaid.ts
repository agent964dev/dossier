// Mermaid diagrams written as `<pre class="mermaid">`. The diagram follows
// the page: Mermaid's dark theme when the page shows dark, and the tree's
// --font-body when it sets one. Labels are text only, whatever the diagram
// asks for. The source stays in data-dossier-source.
import mermaid from 'mermaid'

import type { LibraryContext } from '../../page-client/libraries.ts'
import { isDark, themeVariable } from '../styles.ts'
import { mermaidConfig, textOnly } from './mermaid-safety.ts'

export const render = async (
  elements: readonly Element[],
  context: LibraryContext,
): Promise<void> => {
  const { window } = context
  const first = elements[0]
  if (first === undefined) return
  mermaid.initialize(
    mermaidConfig({
      dark: isDark(window, first),
      font: themeVariable(window, first, '--font-body'),
    }),
  )
  for (const element of elements) {
    element.setAttribute('data-dossier-source', element.textContent ?? '')
  }
  await mermaid.run({
    nodes: elements as unknown as ArrayLike<HTMLElement>,
    suppressErrors: true,
  })
  for (const element of elements) {
    for (const svg of element.querySelectorAll('svg')) textOnly(svg)
  }
}
