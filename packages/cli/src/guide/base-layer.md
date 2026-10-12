## Base layer

Pages get four libraries without a script tag. Each loads only on a page whose
markup uses it, from the page's own host, and leaves markup a page already
renders itself alone:

- Mermaid: `<pre class="mermaid">graph TD; A-->B</pre>`. The diagram takes
  Mermaid's dark theme when the page shows dark, and the tree's `--font-body`.
- Highlighted code: `<pre><code class="language-ts">…</code></pre>`, for every
  language Shiki knows. Colours come from the `--dossier-code-` variables
  (`--dossier-code-token-keyword`, `--dossier-code-background`, …), which
  follow the page's `color-scheme` and which a theme may set. Code reads left
  to right unless the `<pre>` sets `dir`.
- Math, in Pandoc's markup: `<span class="math inline">\(e^{i\pi}\)</span>`
  and `<div class="math display">\[x^2\]</div>`, rendered with KaTeX.
- Diffs, as the `<dossier-diff>` component:
  `<dossier-diff before="v1/plan.md" after="plan.md"></dossier-diff>` or
  `<dossier-diff src="changes.patch"></dossier-diff>`.

`<dossier-copy></dossier-copy>` is a "Copy for agent" button that copies the
page's agent version; `src="../brief/"` copies another page or a folder, and
`label` names the button. `dossier read <folder>` shows write holders each
base component's notes.

Base components render into the page itself, with styles any page or kit CSS
overrides, read the theme variables when the tree sets them (`--primary`,
`--border`, `--radius`, `--ring`, `--font-mono`), and follow the page's
`dir`. A folder's own `_components/dossier-copy.js` replaces the base one for
the pages below it. The agent version keeps the sources: Mermaid as a
`mermaid` code block, math as `$…$` and `$$…$$`, and a diff as a line naming
its files, such as `[Diff: v1/plan.md → plan.md]`.
