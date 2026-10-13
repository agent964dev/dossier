## Page client

Every page gets `window.dossier`, the page client. It acts with the viewer's
permissions, and page code reaches data only through it; a `fetch` to Dossier's
API from page code is refused.

```ts
dossier.me // { email, name, role } of the viewer, or null for a visitor
dossier.page // { path, link, push, embedded, exported }
await dossier.ready // resolves once the page client can answer
dossier.read(path) // a file: Doc or null; a folder ('answers/'): Doc[]
dossier.watch(path, onChange) // calls back at once, then after each change; returns stop()
dossier.write(path, patch, { replace }) // merges into a .json data file; resolves the Doc
dossier.withdraw(path) // your own submission or entry, for good
dossier.upload(file) // resolves { file, name, size, type }
```

`page` holds the page's tree path, its link (the address people open,
`https://<deployment>/<workspace>/<tree>/<path>`, which a handoff can name; an
exported file keeps the link it was exported from), the push it was rendered
from, whether it is embedded in another page, and whether it runs from an
export.

- `read(path)` of a file gives a `Doc`, or `null`; missing and unreadable look
  the same. A folder path ends in `/` and gives a `Doc[]` of every readable file
  below it at any depth, sorted by path, with `_` files left out. A `.json`
  file's `data` is its parsed value, a text file's is its text, and any other
  file's is `null` (load it by its URL).
- `watch(path, onChange)` calls `onChange` at once with the current value (what
  `read` gives) and again after each change at, below or above the path. Call
  the function it returns to stop.
- `write(path, patch, { replace })` merges `patch` into a `.json` data file as
  an RFC 7396 merge patch: objects merge key by key, `null` removes a key, and
  arrays and other values replace. `{ replace: true }` makes the patch the
  whole new value of a file you own. The viewer's own writes show at once in
  `read` and `watch`, and roll back if the deployment refuses them. A folder
  path makes a new entry in the viewer's own folder: `write('ideas/~/', patch)`
  adds `ideas/sara@acme.com/<UTC time>.json`. People with respond can write a
  shared file such as `layout.json`. Page code never writes authored files, `_`
  files, pages or another person's files; a write into a form's target is
  checked against the form, and refused when the form is closed. Only the
  fields the form names may be written there; a JSON field (see Forms) takes
  any JSON object page code draws, merged key by key.
- `withdraw(path)` deletes your own submission or entry with every revision,
  leaving a line in history.
- `upload(file)` stores a file beside the page, at
  `<page name>.uploads/<email>/<name>` (`plan.html` gives
  `plan.uploads/sara@acme.com/cv.pdf`), served only as a download. `file` is
  that path relative to the page.

A `Doc` is `{ path, data, by, at, push }`: `path` relative to the page, `by` the
writer's email for data files (for authored files the pusher's email to members
of the workspace, otherwise their name), `at` an ISO time, and `push` the push
the writer saw.

Paths are relative to the page, like a URL: `/` starts at the tree root and
never goes above it, and `~` is the viewer's email. On
`questions/results.html`, viewed by sara@acme.com:

- `answers/` is `questions/answers/`, a folder: `read` gives `Doc[]`.
- `../plan.json` is `plan.json`.
- `/team/roster.json` is `team/roster.json`.
- `answers/~.json` is `questions/answers/sara@acme.com.json`.
- `ideas/~/` is `questions/ideas/sara@acme.com/`, a new entry for `write`.
- `../../../x.json` leaves the tree and is refused with `forbidden`.
- `~` for a visitor is refused with `sign_in_required`.

Calls reject with a `DossierError { code, message, fix, path }`, where `code` is
one of ten:

- `forbidden`: the viewer may not do this here, or the path leaves the tree.
- `invalid`: a value breaks a rule of the form that targets the file; `path`
  names the field.
- `not_mergeable`: the patch or the stored value is not a JSON object.
- `closed`: every form that targets the file is closed.
- `too_large`: a data file over 1 MiB, an upload over 10 MiB, or a folder read
  over 1,000 files or 10 MiB.
- `rate_limited`: too many writes and sends this minute.
- `sign_in_required`: a visitor, or the session ended.
- `offline`: nothing left the device; try again when online.
- `not_in_export`: an exported copy does not hold this.
- `unavailable`: anything else, with the deployment's message. Any other code
  arrives as `unavailable`.

A request that gets no answer is retried with the same operation, so a write is
never stored twice.

Forms stay automatic: a plain `<form>` needs no page code (see Forms), and
`data-dossier="manual"` or `"off"` hands it to page code.
