# Dossier CLI

The command line for [Dossier](https://github.com/agent964dev/dossier), which
hosts trees of plain HTML. It signs you in to a Dossier deployment and acts
there with an agent key, for you or for a coding agent: push and pull folders,
read the version of a page agents read, watch for answers, share, search and
export.

## Install

The CLI needs Node.js 22.12 or newer.

```sh
npm i -g @agent964/dossier
dossier --help
```

## Sign in

```sh
dossier login <host>
```

`login` prints a link and a code and opens the link in your browser. Sign in
with Google, check that the code matches, and press Allow. The CLI saves an
agent key named after this machine, such as `cli on m4`, in
`~/.config/dossier/config.json` (or under `$XDG_CONFIG_HOME`), readable only by
you. That deployment becomes the default for later commands. Without a host,
`login` uses the default, which starts as `dossier.agent964.com`.

```sh
dossier whoami
```

prints `sara@acme.com on dossier.example.com (key "cli on m4")`.

## A first push and read

```sh
dossier push ./site agent964/acme
dossier read agent964/acme/plan.html
```

`push` makes `agent964/acme` hold exactly the files in `./site`, all at once,
and prints each change and the tree's link. A member's first push to a new
tree name creates the tree. `read` prints the page's agent version: its
companion `.md` if it has one, else Markdown made from the page, ending with
where its data and comments are.

## Verbs

| Verb      | What it does                                                               |
| --------- | -------------------------------------------------------------------------- |
| `login`   | Sign in through the browser and save an agent key for the deployment.      |
| `logout`  | Revoke the agent key this CLI uses and remove it from this machine.        |
| `whoami`  | Show the person, deployment and agent key this CLI acts with.              |
| `update`  | Update the CLI to the latest npm release, or check with `--check`.         |
| `push`    | Publish a local folder to a node of a tree, all at once.                   |
| `pull`    | Copy a node of a tree into a local folder.                                 |
| `rm`      | Delete a file, a folder or a tree, restorable within the retention period. |
| `mv`      | Move or rename a file or folder, or move a tree to another workspace.      |
| `share`   | List, give or take away read, respond or write on a node.                  |
| `ls`      | List what a folder holds.                                                  |
| `read`    | Print what a link gives an agent: a page's agent version, a folder, data.  |
| `export`  | Save a page as one HTML file that opens offline.                           |
| `search`  | Find pages by title and path, or with `in`, by their contents.             |
| `watch`   | Print each change to a tree, folder or file as it happens.                 |
| `log`     | List a folder's or file's history.                                         |
| `diff`    | Print a unified diff between pushes.                                       |
| `restore` | Bring a file or folder back to how it was after a push or at a time.       |

Targets are `workspace/tree/path`, such as `agent964/acme/plans/q3.html`, or a
link to the node.

## Agents and scripts

`dossier --agent-info` prints a guide for agents: every verb with its usage and
flags, the exit codes, and how to write pages, layouts, components and forms.

To use an agent key made in a deployment's settings, set both variables. The
key is sent only to that deployment.

```sh
export DOSSIER_DEPLOYMENT=dossier.example.com
export DOSSIER_KEY=dsk_…
dossier whoami
```

## `--json` and exit codes

Every verb takes `--json` (or `DOSSIER_JSON=1`) and then prints one JSON value
on stdout. A failure prints
`{ "error": { "code": <exit code>, "message", "fix", "path" } }`.

| Code | Meaning                      |
| ---- | ---------------------------- |
| 0    | success                      |
| 1    | failure                      |
| 2    | usage                        |
| 3    | not found or no access       |
| 4    | not signed in or key refused |
| 5    | conflict                     |
| 6    | refused by a rule or a limit |

When the reader of its output stops early, as in `dossier read … | head`, a
verb ends quietly with 141, as a Unix tool does on a closed pipe.

## Update

```sh
dossier update --check
dossier update
```

`update` installs the latest release with the package manager that installed
the CLI (npm, Bun, pnpm or Yarn). For a global npm install you can also run
`npm i -g @agent964/dossier`.

## Reference

[docs/CLI.md](https://github.com/agent964dev/dossier/blob/main/docs/CLI.md)
describes every verb and flag, the config file, links and paths, and the error
JSON.

## License

[MIT](https://github.com/agent964dev/dossier/blob/main/LICENSE).
