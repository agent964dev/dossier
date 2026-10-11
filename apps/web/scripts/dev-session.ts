// Mints a person, a browser session and an agent key for checks an agent runs
// by hand, in the local Worker's D1 or the dev Worker's D1 (--remote), and
// prints the session cookie and the dsk_ key. It refuses any other target and
// is never part of the Worker's build.
//
//   bun apps/web/scripts/dev-session.ts --email someone@example.com
//     [--name "Someone"] [--super-admin] [--remote]

import { execFileSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

import { SESSION_COOKIE, signedSessionCookie } from './session-cookie.ts'

const DATABASE = 'dossier-next-dev'
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000
const web = join(dirname(new URL(import.meta.url).pathname), '..')

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    'super-admin': { type: 'boolean', default: false },
    remote: { type: 'boolean', default: false },
  },
  strict: true,
})

const fail = (message: string): never => {
  console.error(`dev-session: ${message}`)
  process.exit(2)
}

const email = (values.email ?? '').trim().toLowerCase()
if (!/^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/.test(email)) {
  fail('give --email with a plain address')
}
const name = (values.name ?? email.split('@')[0] ?? email).replaceAll("'", '')

/** The Better Auth secret of the chosen target, from its gitignored file. */
const readSecret = (file: string): string => {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return fail(`cannot read ${file}`)
  }
  const line = text
    .split('\n')
    .find((entry) => entry.startsWith('BETTER_AUTH_SECRET='))
  const secret = line?.slice('BETTER_AUTH_SECRET='.length).trim() ?? ''
  return secret === '' ? fail(`${file} has no BETTER_AUTH_SECRET`) : secret
}

const secret = values.remote
  ? readSecret(join(web, '..', '..', '.dev-next-secrets.local'))
  : readSecret(join(web, '.dev.vars'))

const alphanumeric = (length: number) => {
  const alphabet =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  return [...randomBytes(length)]
    .map((byte) => alphabet[byte % alphabet.length])
    .join('')
}

const now = Date.now()
const userId = alphanumeric(32)
const sessionId = alphanumeric(32)
const token = alphanumeric(32)
const keyId = randomBytes(16).toString('base64url')
const key = `dsk_${randomBytes(32).toString('base64url')}`
const keyHash = createHash('sha256').update(key).digest('hex')
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const person = `(select id from "user" where email = ${quote(email)})`
// A stand-in Google account, so the session and key record the account behind
// them as a real sign-in does (device approval needs it).
const subject = `dev-session-${createHash('sha256').update(email).digest('hex').slice(0, 24)}`
const accountRowId = alphanumeric(32)
const googleAccount = `(select id from account where provider_id = 'google' and account_id = ${quote(subject)})`

const statements = [
  `insert into "user" (id, name, email, email_verified, created_at, updated_at)
     values (${quote(userId)}, ${quote(name)}, ${quote(email)}, 1, ${now}, ${now})
     on conflict(email) do update set updated_at = excluded.updated_at`,
  `insert into people (user_id, email_authority, first_sign_in_at, last_sign_in_at)
     values (${person}, 'none', ${now}, ${now})
     on conflict(user_id) do update set last_sign_in_at = excluded.last_sign_in_at`,
  `insert into account (id, user_id, provider_id, account_id, created_at, updated_at)
     values (${quote(accountRowId)}, ${person}, 'google', ${quote(subject)}, ${now}, ${now})
     on conflict(provider_id, account_id) do update set updated_at = excluded.updated_at`,
  `insert into google_accounts (account_id, email, email_authority, observed_at)
     values (${googleAccount}, ${quote(email)}, 'none', ${now})
     on conflict(account_id) do update set observed_at = excluded.observed_at`,
  `insert into "session" (id, user_id, token, expires_at, google_account_id, created_at, updated_at)
     values (${quote(sessionId)}, ${person}, ${quote(token)}, ${now + THIRTY_DAYS}, ${googleAccount}, ${now}, ${now})`,
  `insert into agent_keys (id, user_id, name, hash_sha256, created_via, google_account_id, created_at)
     values (${quote(keyId)}, ${person}, 'dev-session', ${quote(keyHash)}, 'settings', ${googleAccount}, ${now})`,
  ...(values['super-admin']
    ? [
        `insert into super_admins (user_id, added_by, created_at)
           values (${person}, null, ${now}) on conflict(user_id) do nothing`,
      ]
    : []),
]

const folder = mkdtempSync(join(tmpdir(), 'dossier-dev-session-'))
const file = join(folder, 'session.sql')
writeFileSync(file, `${statements.join(';\n')};\n`)
try {
  execFileSync(
    'bunx',
    [
      'wrangler',
      'd1',
      'execute',
      DATABASE,
      values.remote ? '--remote' : '--local',
      '--env',
      'dev',
      '--config',
      'wrangler.jsonc',
      ...(values.remote ? [] : ['--persist-to', '.wrangler/state']),
      '--file',
      file,
      '--yes',
    ],
    { cwd: web, stdio: ['ignore', 'ignore', 'inherit'] },
  )
} finally {
  rmSync(folder, { recursive: true, force: true })
}

const cookie = await signedSessionCookie(token, secret)
console.log(`person   ${email}${values['super-admin'] ? ' (super admin)' : ''}`)
console.log(`target   ${values.remote ? 'dev D1 (remote)' : 'local D1'}`)
console.log(`cookie   ${SESSION_COOKIE}=${cookie}`)
console.log(`key      ${key}`)
