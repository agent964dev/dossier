## History

Every push, deletion, restore, move and withdrawal is a line in its tree's
history. Write holders read it; anyone else gets exit 3. Times print in UTC.

```sh
dossier log agent964/acme/questions/                # newest first, 50 lines a page
dossier log agent964/acme/questions/ --cursor <c>   # the older page the last line names
dossier diff agent964/acme/plan.html                # its last change
dossier diff agent964/acme/plan.html 11             # push 11 against now
dossier diff agent964/acme/plan.html 11 12          # push 11 against push 12
dossier diff agent964/acme/questions/               # the folder's latest push
dossier rm agent964/acme/plan.html
dossier restore agent964/acme/plan.html --to 12
dossier restore agent964/acme/questions/ --to 2026-10-11T09:30:00Z
dossier mv agent964/acme/plan.html agent964/acme/plans/plan.html
dossier mv agent964/acme studio/acme                # a whole tree to another workspace
```

Deleting loses nothing at once: a deleted file or folder can be restored
within the retention period (30 days unless the deployment sets another), and
`dossier rm` prints the command that restores it. Restoring to a push means
how things were just after it. A folder restored to a point gets back the
files it had then, loses the files made since, and keeps data written since.
A path a newer node holds now exits 5; move that node first.

`diff` prints a unified patch, byte for byte. A binary file, or one too large
to show, gets a sentence instead.

A move changes paths, never identities: shares, comments, data and history
go with the node, its old link keeps working, and relative links in pages
that point into or out of it are updated. Data files move only with their
page's folder. Moving a tree to another workspace ends its team shares,
because teams belong to their workspace; `dossier mv` names each one.

Each verb takes `--json` and prints the deployment's answer.
