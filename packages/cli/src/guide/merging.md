## Working from more than one machine

A folder that more than one machine or agent pushes to the same node stays in
step with a merging pull. It brings in what others pushed and keeps this
folder's own changes:

```sh
dossier pull --merge agent964/acme ./site   # before work, and after a push exits 5
# exit 7: resolve each conflict it lists
dossier push ./site agent964/acme
```

1. Run `dossier pull --merge` before you start work, and again whenever a push
   exits 5 because someone pushed since this folder last synced.
2. If it exits 7, resolve each file it lists as `conflict`.
3. Push. If the push exits 5 again, go back to step 1.

The merge compares each file with its copy from this folder's last pull, push
or merge. A file only the tree changed is `taken`, one only the folder changed
is `kept`, and a text file both changed is `merged` line by line. Only what
cannot be merged is a `conflict`:

- Text where both changed the same lines holds both versions between markers.
  Keep the right lines and remove the marker lines:

  ```text
  <<<<<<< local
  Status: review
  =======
  Status: approved
  >>>>>>> push 14
  ```

- A binary file both changed keeps this folder's version, with the tree's
  beside it as `<name>.theirs.<ext>`. Keep one, and delete the `.theirs` file.
- A file changed on one side and deleted on the other is in the folder. Keep
  it, or delete it; the next push sends either.

Until each marker and `.theirs` file is gone, `dossier push` (even with
`--force`) and another `dossier pull --merge` exit 7, change nothing and name
the files. With `--json`, each conflict carries a `fix` that says what to do.

A merge never writes people's data (form answers, comments, uploads) or the
files a push leaves out. A plain `dossier pull` replaces this folder's changes
with the tree's; `--merge` keeps them.
