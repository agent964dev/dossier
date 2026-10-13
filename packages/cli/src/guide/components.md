## Components

A component is a custom element defined by `_components/<tag>.js` (a tag has a
hyphen, such as `acme-card`). A page or layout that uses `<acme-card>` loads
the closest `_components/acme-card.js` at its folder or above, with no script
tag. The element stays hidden until it is defined, at most 3 seconds. A tag
with no file above it renders as its plain text, and the push warns:
`plan.html uses <acme-card>, but no _components/acme-card.js is above it.` A
folder's component replaces the base layer's of the same tag.

`_components/<tag>.md` documents the component; `dossier read <folder>` shows it
to write holders beside the component. A component that needs another file
imports it relative to itself, such as `import './shared.js'`.
