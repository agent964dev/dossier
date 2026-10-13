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
  /** All of stdin, as text, for `dossier comment … -`. */
  readonly stdin?: () => Promise<string>
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

/** How a Unix tool ends when its reader goes away: 128 + SIGPIPE. */
export const CLOSED_PIPE_EXIT = 141

/**
 * Ends the run quietly once the reader of `stream` has gone, as in
 * `dossier read … | head`, instead of crashing on an unhandled EPIPE. Any
 * other write error is thrown as before.
 */
export const endOnClosedPipe = (
  stream: {
    on: (
      event: 'error',
      listener: (error: NodeJS.ErrnoException) => void,
    ) => unknown
  },
  exit: (code: number) => void = (code) => process.exit(code),
): void => {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error
    exit(CLOSED_PIPE_EXIT)
  })
}

export const nodeIo = (): CliIo => {
  endOnClosedPipe(process.stdout)
  endOnClosedPipe(process.stderr)
  return {
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
    stdin: async () => {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
      return Buffer.concat(chunks).toString('utf8')
    },
  }
}
