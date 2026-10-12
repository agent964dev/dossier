## Reading

`dossier read <workspace>/<tree>/<path>` prints a page's agent version.
`dossier read <workspace>/<tree>/<folder>/` prints what the folder holds and,
for write holders, the kit available there: each layout, theme (with the
variables it sets) and component (with its `.md` documentation), closest
first. Read a project's folder before writing pages for it. A data folder
prints each file with who wrote it, when, and the push they saw. An empty
folder prints `Nothing here yet.`

Every verb takes `--json` (or `DOSSIER_JSON=1`) and prints one JSON value; for
`read` it holds the text and, for pages, the pointer as a field. Not found and
no access both exit 3.
