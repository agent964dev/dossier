// The shell.js entry: reads the shell document's boot data and frames the
// page. It adds nothing visible.
import type { ShellBoot } from '@dossier/contracts/bridge'
import { shellApi } from './api.ts'
import { createShell } from './create-shell.ts'
import { browserStore } from './store.ts'

const boot = JSON.parse(
  document.getElementById('dossier-shell')?.textContent ?? 'null',
) as ShellBoot
const frame = document.getElementById('dossier-page') as HTMLIFrameElement

void createShell({
  window,
  frame,
  boot,
  api: shellApi(window.fetch.bind(window), boot.deployment.origin),
  store: browserStore(window.indexedDB),
}).start()
