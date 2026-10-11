import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type ErrorCode, statusFor } from '@dossier/contracts'

import type { CliIo } from './io.ts'
import { runCli } from './run.ts'

export const person = {
  id: 'per_sara',
  email: 'sara@acme.com',
  name: 'Sara',
  image: null,
}

export const errorResponse = (
  code: ErrorCode,
  message = `The deployment says ${code}.`,
  fix: string | null = null,
): Response =>
  Response.json(
    { error: { code, message, fix, path: null } },
    { status: statusFor(code) },
  )

/** One request the stub deployment received, read once. */
export interface SeenRequest {
  readonly method: string
  readonly url: URL
  readonly headers: Headers
  readonly body: unknown
  readonly redirect: RequestRedirect | undefined
}

export type Route = (request: SeenRequest) => Response | Promise<Response>

/** A fetch that answers from `route` and records every request. */
export const stubFetch = (route: Route) => {
  const requests: SeenRequest[] = []
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init)
    const text = await request.text()
    let body: unknown = text
    try {
      body = text === '' ? null : JSON.parse(text)
    } catch {
      // Keep the raw text.
    }
    const seen: SeenRequest = {
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      body,
      redirect: init?.redirect,
    }
    requests.push(seen)
    return route(seen)
  }
  return { fetch: fetch as typeof globalThis.fetch, requests }
}

export interface Harness {
  readonly dir: string
  readonly configPath: string
  readonly sleeps: number[]
  readonly opened: string[]
  readonly stdout: () => string
  readonly stderr: () => string
  readonly run: (argv: readonly string[]) => Promise<number>
  readonly cleanup: () => Promise<void>
}

/** A temporary config directory and an io that writes into strings. */
export const harness = async (options: {
  readonly fetch: typeof globalThis.fetch
  readonly env?: Record<string, string | undefined>
}): Promise<Harness> => {
  const dir = await mkdtemp(join(tmpdir(), 'dossier-cli-'))
  const configPath = join(dir, 'dossier', 'config.json')
  let out = ''
  let err = ''
  const sleeps: number[] = []
  const opened: string[] = []
  const io: CliIo = {
    env: options.env ?? {},
    fetch: options.fetch,
    stdout: (text) => {
      out += text
    },
    stderr: (text) => {
      err += text
    },
    configPath,
    cwd: dir,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    openUrl: (url) => {
      opened.push(url)
    },
    hostname: 'm4',
  }
  return {
    dir,
    configPath,
    sleeps,
    opened,
    stdout: () => out,
    stderr: () => err,
    run: (argv) => {
      out = ''
      err = ''
      return runCli(argv, io)
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}
