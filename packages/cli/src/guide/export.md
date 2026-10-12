## Export

`dossier export <workspace>/<tree>/<path>` saves a page as one HTML file that
opens offline, from disk, with no network: `./<name>.html` by default (an
`index.html` takes its folder's name, the tree's root the tree's), or the file
`-o` names. `--json` prints `{ "file", "bytes", "linked" }`.

The file holds, inlined: the composed page with its layouts, theme and
components and everything they import, its stylesheets, images and fonts, the
base libraries it uses, and the page client in export mode. It also holds a
snapshot of the data the exporter could read when exporting: the page's form
targets, its comments, and the data files in the page's own folder and below.
Data a page script reads from another folder is not in the snapshot; keep data
a page computes paths to under the page's folder.

In the file, forms and page code work, but what they save stays in that
browser only (`dossier.page.exported` is true). Uploads and anything else that
needs Dossier fail with `not_in_export`.

A file past 50 MiB keeps its largest media (video, audio, images) as links to
the deployment, largest first, until it fits; the CLI prints them under
`Linked, not included:`. URLs page code builds at run time are not inlined and
need the network.
