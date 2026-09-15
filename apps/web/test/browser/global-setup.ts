import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { FullConfig } from '@playwright/test'

const webRoot = path.join(import.meta.dirname, '..', '..')
const authDirectory = path.join(import.meta.dirname, '.auth')
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * The second person in the two-page scenarios. It is a workspace admin rather
 * than the document's author, so the specs also prove that saving follows the
 * editor predicate and not ownership.
 */
const SECOND_ACCOUNT_ID = 'acct_browser_second'

/**
 * The third person: no membership, no invite, one verified email. Everything
 * it can do on a document comes from a saved-values grant, which is what the
 * grant spec signs in as it to prove.
 */
const GRANTED_ACCOUNT_ID = 'acct_browser_granted'
const GRANTED_EMAIL = 'granted@browser.test'

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

function persistPath(): string {
  return process.env.DOSSIER_PERSIST_PATH ?? '.wrangler/state-browser'
}

function wrangler(args: readonly string[]): void {
  execFileSync('bunx', ['wrangler', ...args], {
    cwd: webRoot,
    // A non-interactive wrangler applies pending migrations without asking.
    env: { ...process.env, CI: '1' },
    stdio: 'pipe',
  })
}

function applyMigrations(): void {
  wrangler([
    'd1',
    'migrations',
    'apply',
    'DB',
    '--local',
    '--persist-to',
    persistPath(),
    '--env',
    'dev',
  ])
}

/**
 * A second signed-in person for the competing-save scenarios. There is no
 * sign-in surface to drive from a test, so the rows the session cookie stands
 * for are written straight into the local D1 file.
 */
function seedSecondAccount(workspaceId: string): void {
  const now = new Date().toISOString()
  execute('second-account.sql', [
    `INSERT OR IGNORE INTO accounts
       (id, name, kind, deployment_admin, disabled_at, created_at, updated_at)
     VALUES ('${SECOND_ACCOUNT_ID}', 'Second reviewer', 'user', 0, NULL,
             '${now}', '${now}');`,
    `INSERT OR IGNORE INTO memberships (workspace_id, account_id, role, created_at)
     VALUES ('${workspaceId}', '${SECOND_ACCOUNT_ID}', 'admin', '${now}');`,
  ])
}

/**
 * The granted account. It gets an identity row because a grant is matched by
 * verified email, and deliberately no membership row: a grant must open the
 * document on its own.
 */
function seedGrantedAccount(): void {
  const now = new Date().toISOString()
  execute('granted-account.sql', [
    `INSERT OR IGNORE INTO accounts
       (id, name, kind, deployment_admin, disabled_at, created_at, updated_at)
     VALUES ('${GRANTED_ACCOUNT_ID}', 'Granted reviewer', 'user', 0, NULL,
             '${now}', '${now}');`,
    `INSERT OR IGNORE INTO identities
       (id, account_id, provider, subject, email, email_verified,
        display_name, picture_url, pii_subject, created_at, last_login_at)
     VALUES ('identity_browser_granted', '${GRANTED_ACCOUNT_ID}', 'shoo',
             'subject_browser_granted', '${GRANTED_EMAIL}', 1, NULL, NULL,
             NULL, '${now}', '${now}');`,
  ])
}

/** Runs one SQL file against the browser suite's own local D1. */
function execute(name: string, statements: readonly string[]): void {
  const file = path.join(authDirectory, name)
  writeFileSync(file, statements.join('\n'))
  wrangler([
    'd1',
    'execute',
    'DB',
    '--local',
    '--persist-to',
    persistPath(),
    '--env',
    'dev',
    '--file',
    file,
  ])
}

/** Playwright's storageState for one seeded account. */
function writeStorageState(
  file: string,
  input: {
    readonly baseURL: string
    readonly cookieName: string
    readonly token: string
  },
): string {
  const target = path.join(authDirectory, file)
  writeFileSync(
    target,
    JSON.stringify(
      {
        cookies: [
          {
            name: input.cookieName,
            value: input.token,
            domain: new URL(input.baseURL).hostname,
            path: '/',
            expires: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
            httpOnly: true,
            secure: false,
            sameSite: 'Lax' as const,
          },
        ],
        origins: [],
      },
      null,
      2,
    ),
  )
  return target
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

  const cookieName = sessionCookieName(vars.publicBaseUrl)
  mkdirSync(authDirectory, { recursive: true })
  writeStorageState('session.json', {
    baseURL,
    cookieName,
    token: sessionToken(vars.sessionSecret, {
      accountId: seeded.bootstrapAccountId,
      workspaceId: seeded.workspaceId,
    }),
  })

  seedSecondAccount(seeded.workspaceId)
  const secondStorageState = writeStorageState('second.json', {
    baseURL,
    cookieName,
    token: sessionToken(vars.sessionSecret, {
      accountId: SECOND_ACCOUNT_ID,
      workspaceId: seeded.workspaceId,
    }),
  })

  seedGrantedAccount()
  const grantStorageState = writeStorageState('granted.json', {
    baseURL,
    cookieName,
    token: sessionToken(vars.sessionSecret, {
      accountId: GRANTED_ACCOUNT_ID,
      workspaceId: seeded.workspaceId,
    }),
  })

  // The specs publish their own fixtures through the API with this key.
  process.env.DOSSIER_BROWSER_API_KEY = vars.bootstrapApiKey
  process.env.DOSSIER_BROWSER_BASE_URL = baseURL
  process.env.DOSSIER_BROWSER_SECOND_STORAGE = secondStorageState
  process.env.DOSSIER_BROWSER_GRANT_STORAGE = grantStorageState
  process.env.DOSSIER_BROWSER_GRANT_EMAIL = GRANTED_EMAIL
}
