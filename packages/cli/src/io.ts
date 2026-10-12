import { spawn } from 'node:child_process'
import { homedir, hostname } from 'node:os'

import { Context } from 'effect'

import packageJson from '../package.json' with { type: 'json' }
import { defaultConfigPath } from './config.ts'
import type { Output } from './render.ts'

export const VERSION: string = packageJson.version

/** Everything a command touches outside itself, so tests can drive it. */
export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly fetch: typeof globalThis.fetch
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  readonly configPath: string
  readonly cwd: string
  /**
   * Waits between polls; settles early when the signal aborts. Tests pass one
   * that only records.
   */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Opens a link in the browser, best effort. */
  readonly openUrl?: (url: string) => void
  /** Names the device: "cli on <hostname>". */
  readonly hostname?: string
  /** Opens live connections for `dossier watch`; tests pass a fake. */
  readonly webSocket?: typeof globalThis.WebSocket
  /**
   * Calls `stop` on Ctrl-C instead of ending the process; answers a function
   * that gives Ctrl-C back.
   */
  readonly onInterrupt?: (stop: () => void) => () => void
}

/** The running command's io and output. */
export class Cli extends Context.Tag('dossier/Cli')<
  Cli,
  { readonly io: CliIo; readonly output: Output }
>() {}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })

const onInterrupt = (stop: () => void): (() => void) => {
  process.once('SIGINT', stop)
  return () => {
    process.off('SIGINT', stop)
  }
}

const browserCommand = (url: string): [string, string[]] => {
  switch (process.platform) {
    case 'darwin':
      return ['open', [url]]
    case 'win32':
      return ['cmd', ['/c', 'start', '', url]]
    default:
      return ['xdg-open', [url]]
  }
}

const openUrl = (url: string): void => {
  const [file, args] = browserCommand(url)
  try {
    const child = spawn(file, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // The link is printed as well; a missing browser is not a failure.
  }
}

export const nodeIo = (): CliIo => ({
  env: process.env,
  fetch: globalThis.fetch,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  configPath: defaultConfigPath(process.env, homedir()),
  cwd: process.cwd(),
  sleep,
  openUrl,
  hostname: hostname().split('.')[0] || hostname(),
  ...(typeof globalThis.WebSocket === 'function'
    ? { webSocket: globalThis.WebSocket }
    : {}),
  onInterrupt,
})
