import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { FullConfig } from '@playwright/test'

const webRoot = path.join(import.meta.dirname, '..', '..')
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * The secrets the browser job needs. They come from `.dev.vars`, the same file
 * `bun run dev` reads, or from the environment when there is no such file (CI
 * writes one, but an operator may prefer to export them instead).
 */
interface DevVars {
  readonly sessionSecret: string
  readonly bootstrapApiKey: string
  readonly publicBaseUrl: string
}

function parseDevVars(): Record<string, string> {
  const vars: Record<string, string> = {}
  let contents = ''
  try {
    contents = readFileSync(path.join(webRoot, '.dev.vars'), 'utf8')
  } catch {
    return vars
  }
  for (const line of contents.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const equals = trimmed.indexOf('=')
    if (equals < 0) continue
    vars[trimmed.slice(0, equals).trim()] = trimmed.slice(equals + 1).trim()
  }
  return vars
}

function devVars(): DevVars {
  const file = parseDevVars()
  const sessionSecret = process.env.SESSION_SECRET ?? file.SESSION_SECRET
  const bootstrapApiKey =
    process.env.BOOTSTRAP_API_KEY ?? file.BOOTSTRAP_API_KEY
  if (!sessionSecret || !bootstrapApiKey) {
    throw new Error(
      'The browser suite needs SESSION_SECRET and BOOTSTRAP_API_KEY, from ' +
        'apps/web/.dev.vars or the environment. See .dev.vars.example.',
    )
  }
  return {
    sessionSecret,
    bootstrapApiKey,
    publicBaseUrl:
      process.env.PUBLIC_BASE_URL ??
      file.PUBLIC_BASE_URL ??
      'http://localhost:8787',
  }
}

function base64Url(value: Buffer): string {
  return value.toString('base64url')
}

/**
 * The same token `makeSession` signs in the Worker: a base64url JSON body and
 * an HMAC over it, joined by a dot.
 */
function sessionToken(
  secret: string,
  payload: Record<string, unknown>,
): string {
  const body = base64Url(
    Buffer.from(
      JSON.stringify({
        ...payload,
        purpose: 'session',
        exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      }),
      'utf8',
    ),
  )
  const signature = createHmac('sha256', secret).update(body).digest()
  return `${body}.${base64Url(signature)}`
}

/** Mirrors SessionLive: only a real HTTPS deployment gets the __Host- prefix. */
function sessionCookieName(publicBaseUrl: string): string {
  try {
    const url = new URL(publicBaseUrl)
    const production =
      url.protocol === 'https:' &&
      !['localhost', '127.0.0.1'].includes(url.hostname)
    return production ? '__Host-dossier_session' : 'dossier_session'
  } catch {
    return 'dossier_session'
  }
}

function applyMigrations(): void {
  const persistPath =
    process.env.DOSSIER_PERSIST_PATH ?? '.wrangler/state-browser'
  execFileSync(
    'bunx',
    [
      'wrangler',
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
      '--persist-to',
      persistPath,
      '--env',
      'dev',
    ],
    {
      cwd: webRoot,
      // A non-interactive wrangler applies pending migrations without asking.
      env: { ...process.env, CI: '1' },
      stdio: 'pipe',
    },
  )
}

async function waitForServer(baseURL: string): Promise<void> {
  const deadline = Date.now() + 60_000
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseURL}/api/healthz`)
      if (response.ok) return
      lastError = new Error(`healthz answered ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`The dev server never became ready: ${String(lastError)}`)
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL =
    config.projects[0]?.use.baseURL ??
    `http://localhost:${process.env.PLAYWRIGHT_PORT ?? 8790}`
  const vars = devVars()

  applyMigrations()
  await waitForServer(baseURL)

  // Seeds the workspace, the bootstrap service account, and the API key whose
  // hash is BOOTSTRAP_API_KEY, so the specs can publish through the real API.
  const setup = await fetch(`${baseURL}/api/setup`, {
    method: 'POST',
    headers: { authorization: `Bearer ${vars.bootstrapApiKey}` },
  })
  if (!setup.ok) {
    throw new Error(`POST /api/setup answered ${setup.status}`)
  }
  const seeded = (await setup.json()) as {
    readonly workspaceId: string
    readonly bootstrapAccountId: string
  }

  const token = sessionToken(vars.sessionSecret, {
    accountId: seeded.bootstrapAccountId,
    workspaceId: seeded.workspaceId,
  })
  const storageState = {
    cookies: [
      {
        name: sessionCookieName(vars.publicBaseUrl),
        value: token,
        domain: new URL(baseURL).hostname,
        path: '/',
        expires: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax' as const,
      },
    ],
    origins: [],
  }
  const authDirectory = path.join(import.meta.dirname, '.auth')
  mkdirSync(authDirectory, { recursive: true })
  writeFileSync(
    path.join(authDirectory, 'session.json'),
    JSON.stringify(storageState, null, 2),
  )

  // The specs publish their own fixtures through the API with this key.
  process.env.DOSSIER_BROWSER_API_KEY = vars.bootstrapApiKey
  process.env.DOSSIER_BROWSER_BASE_URL = baseURL
}
