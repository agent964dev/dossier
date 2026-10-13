## Kits

A `_` file is a file or folder whose name starts with `_`. It is inherited by
everything below the folder it sits in, and the closest one wins: a page in
`guides/setup/` that asks for `_theme.css` gets `guides/setup/_theme.css`, else
`guides/_theme.css`, else the tree's root `_theme.css`, else the base layer's.
Nothing above the tree's root is read.

A `_` URL resolves from the page, wherever it is written: a layout high in the
tree that links `_theme.css` gives each page the theme closest to that page.
Anyone who can open a page can load the `_` files at its folder and above, so
a page shared on its own renders as its author made it. Files a page needs only
through a stylesheet or a script (a background image in `styles.css`, a module
`app.js` imports) travel with it only when they are `_` files or the folder is
shared.

`_` files are never listed as pages. Write holders see them as the kit in
listings and in `dossier read <folder>`.
