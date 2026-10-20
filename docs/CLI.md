# Dossier CLI

`@agent964/dossier` is the command line for Dossier. It signs a person in to a
deployment, keeps one agent key per deployment, and pushes, pulls, reads,
watches, moves, removes, restores, compares, shares, searches and exports the
nodes of trees. People and coding agents use the same verbs.

`dossier ls` shows where you can work: your workspaces, the trees you can
open with what you may do in each, and what is shared with you.

`dossier --agent-info` prints the guide agents read: every verb with its usage
and flags, the exit codes, and the conventions for writing pages. This file is
the reference for people.

## Install

The CLI needs Node.js 22.12 or newer.

```sh
npm i -g @agent964/dossier
dossier --version
dossier --help
```

Bun, pnpm and Yarn global installs work too. `dossier update` keeps whichever
one installed it up to date.

## Deployments, keys and environment

A deployment is one running Dossier at its own address, such as
`dossier.agent964.com`. The CLI talks to one deployment per command and sends
an agent key only to the deployment it belongs to.

The deployment a command uses is, in order:

1. the deployment of a link given on the command line,
2. `DOSSIER_DEPLOYMENT`,
3. the deployment of the latest `dossier login`,
4. `dossier.agent964.com`.

A deployment is named by its host (`dossier.example.com`), its `https://`
origin, or any link into it. Every deployment is reached over HTTPS. Only a
loopback deployment (`localhost`, `*.localhost`, `127.x.x.x`, `[::1]`) may use
`http://`, and it keeps its port.

### The config file

`dossier login` saves the key in `$XDG_CONFIG_HOME/dossier/config.json`, or
`~/.config/dossier/config.json` when `XDG_CONFIG_HOME` is not set. The folder
is mode 0700 and the file 0600. Each change is written to a temporary file,
synced and renamed into place, under a lock file beside it, so two dossier
processes never interleave their writes.

```json
{
  "version": 1,
  "default": "dossier.agent964.com",
  "deployments": {
    "dossier.agent964.com": {
      "key": "dsk_…",
      "keyName": "cli on m4",
      "person": "sara@acme.com",
      "savedAt": "2026-10-12T09:14:03.000Z"
    }
  }
}
```

`default` is the deployment of the latest login. A file the CLI cannot read
fails every command with a message that names it; repair it, or remove it and
log in again.

`heads.json` sits beside `config.json`. It records, per deployment, tree, path
and local folder, the push each folder last pulled or pushed. `dossier push`
uses it to notice that someone else pushed in between.

`bases/` sits beside them too, with one folder for each local folder. It keeps
the files as that folder last pulled, pushed or merged them: every file's hash,
and the content of the text files. `dossier pull --merge` starts from this copy.
It is one copy per folder, replaced at each sync, never a history. Removing it
is safe: the next merge then treats every difference as a conflict.

### Environment variables

| Variable                      | Effect                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOSSIER_DEPLOYMENT`          | The deployment to use when the command line names none.                                                                                              |
| `DOSSIER_KEY`                 | An agent key for `DOSSIER_DEPLOYMENT`. Used instead of the saved key for that deployment only. Set without `DOSSIER_DEPLOYMENT`, every verb exits 2. |
| `DOSSIER_JSON`                | `1`, `true` or `yes` makes every verb print JSON, as `--json` does.                                                                                  |
| `DOSSIER_UPDATE_REGISTRY_URL` | The npm registry `dossier update` reads. Defaults to `https://registry.npmjs.org`.                                                                   |
| `XDG_CONFIG_HOME`             | Where the config file lives.                                                                                                                         |

To act with a key made in a deployment's settings, for example in CI:

```sh
export DOSSIER_DEPLOYMENT=dossier.example.com
export DOSSIER_KEY=dsk_…
dossier whoami
```

### Agent keys

An agent key starts with `dsk_`. It acts as its person and can be limited to
one tree or node, and to read only. `dossier login` makes a key with no limit,
named after the machine (`cli on m4`). Keys made in settings can carry limits.
A command outside a key's reach answers as if the node did not exist (exit 3),
and a write with a read-only key exits 3 with "You can open this but not change
it." `dossier ls` shows a key limited to a node only that node.

### Protocol and timeouts

Every request carries `Dossier-Protocol: 1`. A deployment that speaks another
protocol answers `protocol_mismatch`, and the CLI exits 1 with "Update the CLI
with dossier update." Each request has 30 seconds. The CLI never follows a
redirect from the API; it reports it and names the host to use.

## Links and paths

Every node has a link:

```text
https://<deployment>/<workspace>/<tree>/<path>
```

- `plan.html` opens at `…/plan`.
- `questions/index.html` opens at `…/questions/`.
- A folder without `index.html` opens at `…/<folder>/` as its listing.
- Any other file keeps its exact path: `…/clip.mp4`.

Workspace and tree names are 1 to 63 lowercase letters, digits and hyphens, not
starting with a hyphen. `api` and `cli` are not workspace names.

Verbs take a target in one of two forms:

- `workspace/tree/path` on the current deployment, such as
  `agent964/acme/plans/q3.html`. `workspace/tree` and `workspace/tree/` name
  the tree's root.
- A link, such as `https://dossier.agent964.com/agent964/acme/plans/q3`. A
  link names its own deployment, so the CLI uses that deployment and its key.

A trailing slash names a folder. `agent964/acme/open/` is the folder `open`;
`agent964/acme/open` is the page `open.html` when one exists, else the folder.
Paths are inside the tree: nothing reaches above its root.

## Verbs

The verbs below are listed in the order `dossier --help` lists them. Every verb
takes `--json`.

### `dossier login`

```sh
dossier login [--json] [<deployment>]
```

Signs in through the browser and saves an agent key for the deployment.
`<deployment>` is a host or a link into the deployment; without it, the
deployment comes from the rules above.

The CLI prints a link and a code such as `WDJB-MJHT`, and opens the link in the
browser when the link is on that deployment. Sign in there, check
that the code matches, and press Allow. The CLI then saves the new key, and the
deployment becomes the default for later commands. A code that expires before
it is approved is replaced once with a new one.

```text
Signed in to dossier.agent964.com as sara@acme.com. The key "cli on m4" is saved.
```

`--json` prints `{ "deployment", "person", "key": { "name" } }`.

### `dossier logout`

```sh
dossier logout [--json]
```

Revokes the agent key this CLI uses on the current deployment and removes it
from the config file. A saved key the deployment already revoked is still
removed. A key from `DOSSIER_KEY` is revoked on the deployment; there is
nothing to remove locally.

`--json` prints `{ "deployment", "key": { "name" }, "revoked", "removedFromConfig" }`.

### `dossier whoami`

```sh
dossier whoami [--json]
```

Shows the person, the deployment and the agent key this CLI acts with:

```text
sara@acme.com on dossier.agent964.com (key "cli on m4")
```

`--json` prints `{ "person", "deployment", "key" }`, where `key` holds the
key's `id`, `name`, `scope` (the node it is limited to, as
`workspace/tree/path`, or null) and `readOnly`. Without a key, `whoami` exits 4
and names the `dossier login` command to run.

### `dossier update`

```sh
dossier update [--check] [--json]
```

Reads the latest version of `@agent964/dossier` from npm and installs it with
the package manager that installed the CLI: `npm install -g`, `bun add -g`,
`pnpm add -g` or `yarn global add`, always of the exact version it read.
`--check` only reports.

- A CLI run through `npx` or `bunx` names the command to run instead.
- A CLI run from a checkout of the repository says to update the checkout.
- On Windows, `update` names the `npm install -g` command to run with elevated
  rights.

`update` talks only to npm, never to a deployment, so it works against any
deployment, including one that runs an older protocol.

`--json` prints `{ "ok", "currentVersion", "latestVersion", "installMethod", "updateAvailable", "checked", "updated" }`.

### `dossier push`

```sh
dossier push [-m, --message <text>] [--dry-run] [--force] [--share <target>:<role>]... [--json] <dir> <target>
```

Publishes a local folder to a node of a tree, all at once. After the push, the
target path holds exactly the folder's files: files the folder no longer has
are removed there. Either the whole push lands or none of it.

| Flag                      | Effect                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-m`, `--message <text>`  | A note on what the push changes, at most 500 characters.                                                                                                |
| `--dry-run`               | Checks the folder and prints what would change. Publishes nothing.                                                                                      |
| `--force`                 | Pushes even if someone pushed to the path since this folder last pulled or pushed.                                                                      |
| `--share <target>:<role>` | Shares the pushed node as the push commits. Repeat for more: `--share sara@acme.com:respond --share anyone:read`. Targets and roles as `dossier share`. |

What is pushed:

- Every file under `<dir>`, except `.git`, `node_modules` and `.DS_Store` at
  any depth, the `.dossierignore` file, and what `.dossierignore` lists in
  gitignore syntax.
- Files under a data folder at the target are never pushed over. They print as
  `ignored`; a push leaves people's data alone.

Before anything is uploaded, the CLI checks the folder with the same rules the
deployment uses: page and path rules, forms, layouts and components. A rule a
push breaks exits 6 with the file, line and fix. Things worth knowing that do
not stop a push, such as a component tag with no `_components/<tag>.js` above
it, print as warnings.

A member's first push to a tree name the workspace does not have creates the
tree. A push into an existing path exits 5 if someone pushed there since this
folder last pulled or pushed. Run `dossier pull --merge` to bring their changes
in and keep yours, then push again. `--force` replaces what is there instead.

A push exits 7 and sends nothing while a file that `dossier pull --merge` left
in conflict is not resolved: a text file that still has its conflict markers,
or a `.theirs` file still in the folder. `--force` does not change this. The
message names each file.

```text
added    plans/q3.html
changed  plan.html
deleted  old.html
warning  plan.html uses <acme-card>, but no _components/acme-card.js is above it.
https://dossier.agent964.com/agent964/acme/  (push 12)
```

A push with nothing to change prints `No changes.` and the link, and gives no
shares. `--json` prints `{ "push", "link", "added", "changed", "deleted", "ignored", "warnings", "dryRun" }`;
`push` is null for a dry run.

### `dossier pull`

```sh
dossier pull [--merge] [--json] <target> <dir>
```

Copies a node of a tree into a local folder: every file you can read at or
below it, `_` files included. Data files people wrote through forms are written
read-only (mode 0444). The CLI records the push it pulled, so a later
`dossier push` from that folder knows its base. A plain pull overwrites local
changes; `--merge` keeps them.

Pull refuses to write through a symbolic link on the way to any file, and
writes each file to a temporary file before renaming it into place.

```text
pulled   plan.html
pulled   questions/index.html
Pulled 2 files into ./acme at push 12.
```

`--json` prints `{ "written", "unchanged", "seq", "push", "dir" }`.

#### Merging with `--merge`

`dossier pull --merge <target> <dir>` brings the tree's changes into a folder
and keeps the folder's own. Use it when more than one machine or agent pushes
the same node:

1. Run `dossier pull --merge` before you start work, and again whenever a push
   exits 5 because someone pushed in between.
2. If it exits 7, resolve each conflict it lists.
3. Push.

The merge compares three versions of each file: the base (the file as this
folder last pulled, pushed or merged it, kept in `bases/`), the folder's file
now, and the tree's file now.

| Folder since the base | Tree since the base | Result                                             | Line                  |
| --------------------- | ------------------- | -------------------------------------------------- | --------------------- |
| not changed           | changed or added    | the tree's file is written                         | `taken`               |
| not changed           | deleted             | the file is deleted                                | `deleted`             |
| changed or added      | not changed         | the folder's file stays                            | `kept`                |
| deleted               | not changed         | the file stays deleted                             | `kept (deleted here)` |
| the same change       | the same change     | nothing to do                                      |                       |
| changed (text)        | changed (text)      | the lines are merged                               | `merged`, `conflict`  |
| changed (binary)      | changed (binary)    | the folder's file stays; the tree's goes beside it | `conflict`            |
| deleted               | changed             | the tree's file comes back                         | `conflict`            |
| changed               | deleted             | the folder's file stays                            | `conflict`            |

Where both sides changed the same lines of a text file, both versions stay,
between git-style markers:

```text
<<<<<<< local
Status: review
=======
Status: approved
>>>>>>> push 14
```

Keep the right lines and remove the marker lines. A binary file both sides
changed keeps the folder's version, and the tree's is written beside it as
`<name>.theirs.<ext>`, such as `logo.theirs.png`; keep one and delete the
`.theirs` file. A file changed on one side and deleted on the other is resolved
by keeping it or deleting it; the next push sends either.

```text
kept     draft.html
conflict logo.png  (both sides changed it; the tree's version is in logo.theirs.png)
taken    new.html
deleted  notes.html
merged   plan.html
Merged the tree at push 14 into ./acme; 1 conflict to resolve, then push.
```

A merge never writes or deletes people's data (form answers, comments,
uploads), nor any file that a push leaves out (see `dossier push`). Afterwards
the folder's base is the tree as merged, so the next push is not refused for
the changes just merged in. `--merge` takes a folder, not a single file.

A folder with no copy of its last sync, such as one pulled by an older CLI, is
merged as if both sides had added every file. Identical files need nothing,
and every text file that differs becomes one conflict. An empty folder fills as
with a plain pull, without people's data. A copy counts only when it matches
the sync `heads.json` records, and a text file whose copy is missing or damaged
becomes one conflict; a merge never guesses a base.

The merge checks each file again just before it replaces or deletes it. If you
edited the file while the merge ran, the merge stops and keeps your edit; run
it again. It also stops, before it changes anything, where the tree's file
would land on something else in the folder: a folder of the same name, or, on
a file system that ignores letter case (as macOS does by default), a file whose
name differs only in case. A file the tree only renamed by letter case is
followed. A merge that stops part way keeps the conflicts it already wrote, so
push still waits for them.

The merge exits 0 when nothing is left to resolve and 7 when conflicts remain.
While they remain, `dossier push` and another `dossier pull --merge` exit 7 and
name the files. A plain `dossier pull` does not clear them.

`--json` prints `{ "files", "unchanged", "conflicts", "base", "seq", "push", "dir" }`.
Each file has `path` and `result`. A conflict also has `conflict` (`text`,
`binary`, `deleted-here` or `deleted-there`) and `fix`, and a binary conflict
has `theirs`. `base` is false when the folder had no copy of its last sync.

### `dossier rm`

```sh
dossier rm [--json] <path>
```

Deletes a file, a folder or a whole tree. Give the tree's root as
`workspace/tree/` to delete the tree. Write holders only.

Nothing is lost at once. The deleted node stays in history and can be restored
within the retention period (30 days unless the deployment sets another).
`rm` prints the command that restores it:

```text
Deleted agent964/acme/plan.html. Restore it with `dossier restore agent964/acme/plan.html --to 2026-10-12T09:14:02.999Z` within 30 days.
```

Deleting a comment file blanks the comment. Exits 3 on a node you cannot
delete, 5 when it changed while deleting.

### `dossier mv`

```sh
dossier mv [--json] <from> <to>
```

Moves or renames a file or a folder within its tree, or moves a whole tree to
another workspace or name:

```sh
dossier mv agent964/acme/plan.html agent964/acme/plans/plan.html
dossier mv agent964/acme studio/acme
```

A move changes paths, never identities. Shares, comments, data and history go
with the node, and its old link keeps working. Relative links in pages that
point into or out of it are rewritten, and the output says how many files
changed. A page's `<page>.comments/` folder moves with it.

Moving a tree to another workspace ends its team shares, because teams belong
to their workspace. `mv` names each one. Exits 3 on a node you cannot move, 5
when its new path is taken, 6 on a move a rule refuses.

### `dossier share`

```sh
dossier share [--remove] [--json] <path> [<target>] [<role>]
```

Lists a node's shares, gives a target a role on it, or takes a share away.

```sh
dossier share agent964/acme/questions/                         # list
dossier share agent964/acme/questions/ sara@acme.com respond
dossier share agent964/acme/questions/ team:Design read
dossier share agent964/acme/ workspace write
dossier share agent964/acme/brief.html anyone read
dossier share agent964/acme/questions/ sara@acme.com --remove
```

Targets: an email, `team:<name>`, `workspace`, or `anyone`. Roles: `read`
(open it), `respond` (open it and answer its forms), `write` (push, share, and
see every answer). Roles add up across shares, and a share on a folder covers
everything inside it.

`anyone` makes the node public: anyone with the link opens it without signing
in, along with the files its pages need. Answering a form still asks them to
sign in. Exits 3 on a node you cannot share, 6 on a target or role
that is not one.

### `dossier ls`

```sh
dossier ls [--json] [<target>]
```

Lists where you can work, one workspace, or what a folder holds.

```sh
dossier ls                        # where you can work
dossier ls agent964               # one workspace
dossier ls agent964/acme/plans/   # a folder
```

With no target, or a link to the deployment's root, `ls` lists your
workspaces with your role in each (`admin` or `member`, and `suspended`
while a super admin has suspended it), the trees of each you can open, with
what you may do at each tree's root (`read`, `respond` or `write`), and then
what others shared with you, newest first. Each row starts with what the
other verbs take:

```text
agent964/           workspace  admin
agent964/acme/      tree       write
agent964/handbook/  tree       read
studio/             workspace  member

Shared with you:
globex/plans/q3           page    respond  Q3 plan · waiting for your answer
agent964/acme/questions/  folder  respond  Questions · mentioned you
```

`--json` prints `{ "scope", "workspaces", "shared" }`. Each workspace is
`{ "name", "role", "suspended", "trees" }`, each tree
`{ "name", "target", "link", "can" }`, and each share
`{ "workspace", "tree", "path", "kind", "title", "target", "link", "can", "sharedAt", "waiting", "mentioned" }`.

With a workspace (`agent964`, `agent964/` or its link), `ls` lists, for a
member, the workspace's trees you can open and its teams with their member
counts, by the names `team:<name>` shares with and `@team:<name>` mentions,
and ends with how to make a tree:

```text
agent964/           workspace  member
agent964/acme/      tree       respond
agent964/handbook/  tree       read

Shared with you here:
agent964/acme/questions/  folder  respond  Questions · mentioned you

Teams: share with team:<name>, mention with @team:<name> (@team:"<name>" when it has a space):
Design      4 members
Design Ops  1 member

Make a tree by pushing to a new tree name: dossier push <folder> agent964/<tree>/
```

Someone who is not a member but was given something in the workspace sees
only what they were given, under `Shared with you in agent964:`, and no
teams. A workspace you are not in and have nothing in answers like one that
does not exist: exit 3. `--json` prints
`{ "name", "role", "suspended", "trees", "shared", "teams", "createsTrees", "scope" }`;
`role` and `teams` are null for someone who is not a member.

What each caller sees follows the home screen's rules:

- A tree is listed when you can open its root. Something shared with you on
  its own, such as a folder or a page, is listed under what is shared with
  you.
- `can` is what you may do now at that node, through every grant you hold.
  A read-only agent key shows `read` everywhere and never offers to make a
  tree; nor does a suspended workspace.
- An agent key limited to one node sees only that node: `scope` names it,
  with what you may do there, and `workspaces`, `shared` and `teams` stay
  empty. `dossier ls <workspace>` answers only for that node's workspace.

```text
agent964/acme/plans/  write
This key is limited to agent964/acme/plans/; it sees nothing else.
```

With `workspace/tree` or a path in it, `ls` lists what that folder holds:
pages, folders, attachments, `_` files as the kit, and data. Each row gives
the name (a folder ends in `/`), its kind, its size and the push that last
changed it. An empty folder prints `Nothing here yet.`

### `dossier read`

```sh
dossier read [--json] <target>
```

Prints what the link gives an agent, byte for byte:

- A page: its agent version. That is its companion if it has one (the file its
  `<link rel="alternate">` names, or the same-name `.md`), else Markdown made
  from the page, ending with a line that says where its data and comments are.
- A folder (`…/questions/`): what it holds and, for write holders, the kit at
  that point: each layout, theme and component, closest first.
- A data folder (`…/answers/`): each file with who wrote it, when, and the push
  they saw.
- A comments folder (`…/plan.comments/`): the threads.

An empty folder prints `Nothing here yet.` `--json` holds the text and, for a
page, the pointer to its data and comments as a field.

### `dossier comment`

```sh
dossier comment [--json] [--on <element id>] [--reply-to <thread path>] [--stance <stance>] <page> <text>
dossier comment [--json] --resolve <thread> [<page>]
dossier comment [--json] --reopen <thread> [<page>]
```

Comments on a page, as the comments on the page do, and it shows there as an
agent's comment, marked "Agent". `<text>` may be `-` to read it from stdin.

```sh
dossier comment agent964/acme/plan "Per truck from December. @lina@acme.com"
dossier comment agent964/acme/plan --on pricing --stance agree "Agreed."
dossier comment agent964/acme/plan --reply-to plan.comments/lina@acme.com/2026-10-10T09-14-03.json -
```

`--on` names the id of the element the comment is about; without it the
comment is on the whole page. `--reply-to` takes a thread's path: the one
`dossier comment` prints, or a thread's `data.root.path` in
`dossier read --json <page>.comments/`. `--stance` takes one of the stances the
page offers. `@sara@acme.com` mentions a person and `@team:Design` (or
`@team:"Design Ops"`) a team of the page's workspace; they are notified in
Dossier, never by email, and a reply notifies the thread's other writers.

It needs respond on the page. Anything written with an agent key is an
agent's comment: Dossier marks it from the key, never from the request, and
page code reads it as `agent: true`. The comment is yours, so you edit or
delete it on the page. It prints the comment's path, which `--reply-to` takes,
and its link, which opens it on the page. Exits 3 on a page you cannot open
or comment on, 6 on a comment a rule refuses (too long, an element or stance
the page does not have, a thread that is not there).

`--resolve` resolves a thread and `--reopen` opens it again, as Resolve and
Reopen on the page do; anyone who may comment on the page may do either. Name
the thread by its root comment:

```sh
dossier comment --resolve agent964/acme/plan.comments/lina@acme.com/2026-10-10T09-14-03.json
dossier comment agent964/acme/plan --reopen plan.comments/lina@acme.com/2026-10-10T09-14-03.json
dossier comment --resolve 'https://dossier.agent964.com/agent964/acme/plan#dossier-comment=…'
```

On its own, `<thread>` is `workspace/tree/<path>` with the comment's full
path inside the tree: for a thread on `questions/index.html`, that is
`agent964/acme/questions/index.comments/…`. After the page, it is the path
`dossier comment` prints, from the page's folder. A link that opens the comment, as a notification gives it, names
both. A resolve or reopen takes no text, `--on`, `--reply-to` or `--stance`.

```text
Resolved plan.comments/lina@acme.com/2026-10-10T09-14-03.json on plan.html.
https://dossier.agent964.com/agent964/acme/plan#dossier-comment=plan.comments%2Flina%40acme.com%2F2026-10-10T09-14-03.json&on=pricing
```

A thread already resolved, or already open, is left as it is, and the first
line says `… was already resolved.` (or `open`); it still exits 0. `--json`
prints `{ "thread", "page", "resolved", "changed", "link" }`. Exits 3 on a page
you cannot open or comment on, or with a read-only key or one that does not
reach the page's comments; 6 on a thread that is not one, such as a reply.

### `dossier export`

```sh
dossier export [-o, --output <file>] [--json] <link>
```

Saves a page as one HTML file that opens offline: its layouts, theme,
components, images, fonts and the base libraries it uses are inlined, with a
snapshot of the data you can read (the page's form targets, its comments, and
data files under the page's folder).

The file is `./<name>.html` by default: a page's name, an `index.html`'s folder
name, or the tree's name for the root. `-o` names the file, or a folder to
write it into under that name. The CLI writes a temporary
`.dossier-export-<uuid>.tmp` beside it and renames it when complete.

Forms and page code work in the file, but what they save stays in that browser.
A file past 50 MiB keeps its largest media as links to the deployment until it
fits; the CLI lists them under `Linked, not included:`. `--json` prints
`{ "file", "bytes", "linked" }`.

### `dossier search`

```sh
dossier search [--offset <n>] [--json] <words>...
dossier search in [--offset <n>] [--json] <words>...
```

Finds what you can open on the current deployment, across every workspace and
tree.

- `dossier search <words>` looks in titles and paths, and finds pages,
  folders and files.
- `dossier search in <words>` looks in the contents of pages and in their
  companions (for anyone who can read the companion), and finds pages. Each
  result shows the words around the match on the next line.

People's answers and other data are never searched. Accents and Arabic marks
are ignored. A search is at most 200 characters.

```text
Warehouse layout  https://dossier.agent964.com/agent964/acme/mockups/warehouse
  … moves pallets from the depot to the …
More results: dossier search in depot --offset 20
```

Results come 20 a page. `--offset` starts at a later result, as the last line
gives it, from 0 to 180. When nothing matches, `search` prints
`No pages match "<words>".` and exits 0.

`--json` prints `{ "query", "mode", "results", "next" }`. `mode` is `titles`
or `content`. Each result is `{ "kind", "title", "workspace", "tree", "path", "link", "snippet" }`,
where `kind` is `page`, `folder` or `attachment`, and `snippet` (content mode
only) is a list of `{ "text", "match" }` parts. `next` is the offset of the
next page, or null on the last.

### `dossier watch`

```sh
dossier watch [--next] [--json] <target>
```

Prints each change to a tree, folder or file as it happens, one line each:
when, the event, its path and who. Events are `push`, `delete`, `restore`,
`move`, `submission`, `entry`, `withdrawal`, `data_write`, `comment`,
`mention` and `share`. A folder path ends in `/`.

`watch` runs until Ctrl-C. `--next` prints the first event and exits 0, so an
agent can wait for the next submission and then `dossier read` the folder.
`--json` prints one JSON object per line: the event (`cursor`, `type`, `path`,
`at`, `by`, `push`) and its `link`.

You see only events on nodes you can read. `watch` keeps a live connection and
reads the events after the last one it printed at each hint. When the
connection drops, it polls every 10 seconds and opens the connection again
after 1, 2, 4 and up to 60 seconds, so no event is skipped.

### `dossier log`

```sh
dossier log [--cursor <text>] [--json] <path>
```

Lists a folder's or a file's history, newest first: pushes, deletions,
restores, moves and withdrawals, 50 lines a page, times in UTC. The last line
names the `--cursor` for the next, older page. Write holders only; anyone else
gets exit 3.

### `dossier diff`

```sh
dossier diff [--json] <path> [<from>] [<to>]
```

Prints a unified diff, byte for byte.

```sh
dossier diff agent964/acme/plan.html          # its last change
dossier diff agent964/acme/plan.html 11       # push 11 against now
dossier diff agent964/acme/plan.html 11 12    # push 11 against push 12
dossier diff agent964/acme/questions/         # the folder's latest push
```

A binary file, or one too large to show, gets a sentence instead. Exits 3 on a
node whose history you cannot read, 6 on a push number that is not one.

### `dossier restore`

```sh
dossier restore --to <push|time> [--json] <path>
```

Brings a file or a folder, deleted or not, back to how it was just after a
push, or at a time, and prints the files that changed. `--to` takes a push
number from `dossier log` or an ISO 8601 time such as `2026-10-11T09:30:00Z`.

```sh
dossier restore agent964/acme/plan.html --to 12
dossier restore agent964/acme/questions/ --to 2026-10-11T09:30:00Z
```

A restored folder matches that point: files made since are deleted, and data
written since stays. Exits 3 on a node you cannot restore or past the
retention period, 5 when a newer node holds its path (move it first), 6 on a
point it did not exist at.

## `--json`

Every verb takes `--json`, before or after the verb, and then prints one JSON
value on stdout. `DOSSIER_JSON=1` does the same for every command. Progress a
person would read goes to stderr under `--json`, so stdout stays one value.
`dossier watch --json` is the one exception: it prints one value per line, one
per event.

## Exit codes and the error JSON

| Code | Meaning                      |
| ---- | ---------------------------- |
| 0    | success                      |
| 1    | failure                      |
| 2    | usage                        |
| 3    | not found or no access       |
| 4    | not signed in or key refused |
| 5    | conflict                     |
| 6    | refused by a rule or a limit |
| 7    | merge conflicts to resolve   |

Not found and no access are the same answer, exit 3, so a path you cannot read
looks like one that does not exist.

Exit 7 comes from the CLI, not the deployment. `dossier pull --merge` exits 7
when it leaves conflicts. `dossier push` and `dossier pull --merge` exit 7, and
change nothing, while those conflicts are not resolved.

Some of the deployment's error codes and their exits:

| Error code                                                                                         | Exit |
| -------------------------------------------------------------------------------------------------- | ---- |
| `not_found`, `forbidden`                                                                           | 3    |
| `sign_in_required`, `device_expired`, `access_denied`                                              | 4    |
| `conflict`, `stale_head`, `form_changed`, `blob_reclaiming`                                        | 5    |
| `invalid`, `policy_rejected`, `too_large`, `closed`, `rate_limited`, `not_mergeable`, `last_admin` | 6    |
| `unavailable`, `protocol_mismatch`                                                                 | 1    |

In text, a failure prints `dossier: <message>` on stderr, then the fix on the
next line when there is one. Under `--json` it prints one value on stdout:

```json
{
  "error": {
    "code": 3,
    "message": "Nothing is here, or you cannot open it.",
    "fix": "Check the path, or ask someone who can open it to share it with you.",
    "path": "plan.html"
  }
}
```

`code` is the exit code. `fix` says what to do, and `path` names the file or
field the failure is about. Both may be null.

## `--agent-info`

```sh
dossier --agent-info
dossier --agent-info --json
```

Prints the guide for agents as Markdown: what a deployment, workspace and tree
are, every verb with its usage and flags, the exit codes, and the conventions
for writing pages (kits, layouts, themes, components, the base layer,
embedding, forms, the page client, live data, agent versions, reading,
sharing, export, history, and working from more than one machine). The verbs and flags come from the same
declarations as `--help`, so the guide always matches the installed CLI.
`--json` gives the same guide as JSON.
