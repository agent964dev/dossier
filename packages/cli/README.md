# Dossier CLI

The command line for [Dossier](https://github.com/agent964dev/dossier). It signs
you in to a Dossier deployment and acts there with an agent key, for you or for
a coding agent.

## Install

The CLI needs **Node.js 22.12 or newer**.

```sh
npm install --global @agent964/dossier
dossier --help
```

## Sign in

```sh
dossier login
```

`login` prints a link and a code, and opens the link in your browser. Confirm
that the code matches and press Allow. The CLI then saves an agent key named
after this machine, such as `cli on m4`, in `~/.config/dossier/config.json`
(or under `$XDG_CONFIG_HOME`), readable only by you.

By default the CLI talks to [dossier.agent964.com](https://dossier.agent964.com).
To sign in to another deployment, give its host or any link into it. It becomes
the default for later commands.

```sh
dossier login dossier.example.com
```

## Who am I, and signing out

```sh
dossier whoami
dossier logout
```

`whoami` prints the person, the deployment and the agent key, for example
`sara@acme.com on dossier.agent964.com (key "cli on m4")`. `logout` revokes the
agent key on the deployment and removes it from this machine.

## Scripts and agents

To use an agent key created in settings, set both variables. The key is sent
only to that deployment.

```sh
export DOSSIER_DEPLOYMENT=dossier.example.com
export DOSSIER_KEY=dsk_…
dossier whoami
```

`DOSSIER_KEY` without `DOSSIER_DEPLOYMENT` is refused.

Every verb takes `--json` (or `DOSSIER_JSON=1`) and then prints one JSON value
on stdout. A failure prints
`{ "error": { "code": <exit code>, "message", "fix", "path" } }`.

`dossier --agent-info` prints a guide for agents: every verb with its usage and
flags, and the exit codes. `dossier --agent-info --json` gives the same as JSON.

## Exit codes

| Code | Meaning                      |
| ---- | ---------------------------- |
| 0    | success                      |
| 1    | failure                      |
| 2    | usage                        |
| 3    | not found or no access       |
| 4    | not signed in or key refused |
| 5    | conflict                     |
| 6    | refused by a rule or a limit |

## Update

```sh
dossier update --check
dossier update
```

`update` installs the latest release with the package manager that installed
the CLI. For a global npm install you can also run
`npm install --global @agent964/dossier@latest`.

## License

[MIT](https://github.com/agent964dev/dossier/blob/main/LICENSE).
