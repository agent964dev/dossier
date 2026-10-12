## Dossier

A deployment is one running Dossier at its own address. It holds workspaces,
and a workspace holds trees. A tree is a folder of plain files: pages (`.html`
files, or folders holding `index.html`), attachments (any other file), `_`
files (the kit), and data (what people send through forms).

Every node has a link: `https://<deployment>/<workspace>/<tree>/<path>`.
`plan.html` opens at `…/plan`, `questions/index.html` at `…/questions/`, and a
folder without `index.html` opens as its listing. The CLI takes the same
`<workspace>/<tree>/<path>` or the link itself.

One push is one change. `dossier push <folder> <workspace>/<tree>/<path>` makes
that path hold exactly the folder's files, all at once or not at all; files the
folder no longer has are removed there. A member's first push to a tree name
the workspace does not have creates the tree.

Each tree's pages run on the tree's own origin
(`https://<tree-id>.dossier-content.com`), apart from Dossier and from every
other tree. Pages get their own `localStorage`, `sessionStorage` and IndexedDB,
embeds from other sites (YouTube, Vimeo, maps, Figma) play, and page code never
sees the viewer's session. Write links between pages relative to the page,
such as `href="plan"` or `href="../guides/setup"`.
