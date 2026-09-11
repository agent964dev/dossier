# Upstream baseline

Verbatim copy of the `postplan` npm package, version 0.0.4 (published 2026-07-01,
maintainer t3dotgg, MIT). Copied from `/opt/homebrew/lib/node_modules/postplan` on
2026-09-11. No public source repository was found; this tarball is the baseline.

Known drift from the live postplan.dev service (observed 2026-09-11):

- Live serving CSP is `script-src 'unsafe-inline'` plus a `sandbox allow-scripts
  allow-popups allow-popups-to-escape-sandbox` directive. The packaged
  `src/api.js` still sends `script-src 'none'` with no sandbox.
- Everything else observed (upload policy, delete/disable routes, list shape,
  dashboard) matched the package.

Treat this directory as read-only reference. New code lives outside it.
