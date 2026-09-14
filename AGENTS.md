# Repository workflow

- After merging a pull request, delete its local and remote branches and prune
  stale remote-tracking references.
- Preserve files in linked worktrees. If a merged branch is checked out in a
  clean worktree, detach that worktree at its current commit before deleting the
  branch. Never discard uncommitted work to clean up a branch.
