## Sharing

A share gives a person, a team, the workspace or anyone a role on a node:

- `read`: open it.
- `respond`: open it and answer its forms. A respondent sees only their own
  answers and the shared files the forms edit.
- `write`: push, share, and see every answer.

Roles add up across shares: read on a folder and respond on a page inside it
give both. A share on a folder covers everything inside it, and a lower node
cannot narrow it. Workspace admins hold write on every tree.

Targets: `sara@acme.com`, `team:Design`, `workspace`, `anyone`. A member
finds the workspace's teams with `dossier ls <workspace>`.

```sh
dossier share <workspace>/<tree>/<path>                       # list
dossier share agent964/acme/questions/ sara@acme.com respond
dossier share agent964/acme/questions/ sara@acme.com --remove
dossier push ./site agent964/acme --share sara@acme.com:respond --share anyone:read
```

A page shared on its own carries what it needs: the files its markup loads
(images, stylesheets, scripts, frames), its comments and the data its forms
write, and, through the folders above, its layouts, themes and components
(`_` files). A page shared on its own carries the files its markup loads, not files referenced only from inside its stylesheets or scripts, or URLs its scripts build. Share the folder for those, or keep them in a `_` folder.

A public share (`anyone`) lets anyone with the link open the node without
signing in; answering a form asks them to sign in with Google. Public reach
covers the node, the files its pages need and the `_` files above, never a
page above it, and never people's answers unless the shared node is a data
folder itself. `anyone` with `write` lets anyone with a Google account publish
pages there.

Revoking a share closes that person's live watches on the tree.
