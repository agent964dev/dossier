import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const packageDirectory = new URL('..', import.meta.url).pathname
const artifact = join(packageDirectory, 'dist/index.js')
let server: Server
let apiUrl: string
let home: string

beforeAll(async () => {
  await exec('bun', ['build', 'src/index.ts', '--target=node', '--outfile', 'dist/index.js'], {
    cwd: packageDirectory,
  })
  home = await mkdtemp(join(tmpdir(), 'dossier-cli-integration-'))
  server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/healthz') {
      response.end(JSON.stringify({ ok: true, service: 'dossier', version: '0.0.0' }))
      return
    }
    if (request.url === '/api/me') {
      if (request.headers.authorization !== 'Bearer ds_integration') {
        response.statusCode = 401
        response.end(JSON.stringify({ ok: false, code: 'unauthenticated' }))
        return
      }
      response.end(
        JSON.stringify({
          ok: true,
          account: { id: 'acct_test', name: 'Test User' },
          workspace: { id: 'ws_test', slug: 'test', role: 'admin' },
        }),
      )
      return
    }
    response.statusCode = 404
    response.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind TCP')
  apiUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  await rm(home, { recursive: true, force: true })
})

async function cli(
  runtime: 'node' | 'bun',
  args: readonly string[],
  input?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime, [artifact, ...args], {
      env: { ...process.env, DOSSIER_HOME: home },
      stdio: 'pipe',
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }))
    child.stdin.end(input)
  })
}

describe('built CLI', () => {
  it('runs the hidden health command under Node with globals after the command', async () => {
    const { stdout, stderr, exitCode } = await cli('node', ['health', '--api-url', apiUrl, '--json'])
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({ ok: true, service: 'dossier', version: '0.0.0' })
  })

  it('keeps health hidden from root help', async () => {
    const help = await cli('node', ['--help'])
    expect(help.exitCode).toBe(0)
    expect(help.stdout).not.toMatch(/- health/)
  })

  it('uses the shared static policy before the phase-zero upload stub', async () => {
    const invalid = join(home, 'invalid.html')
    const configurable = join(home, 'configurable.html')
    await writeFile(invalid, '<!doctype html><form></form>', 'utf8')
    await writeFile(
      configurable,
      '<!doctype html><link rel="stylesheet" href="https://styles.example/theme.css"><p>safe</p>',
      'utf8',
    )

    const rejected = await cli('node', ['upload', invalid])
    expect(rejected.exitCode).toBe(1)
    expect(rejected.stderr).toContain('Blocked <form> tag found.')

    const acceptedByStaticRules = await cli('node', ['upload', configurable])
    expect(acceptedByStaticRules.exitCode).toBe(1)
    expect(acceptedByStaticRules.stderr).toContain('not implemented in phase 0')
    expect(acceptedByStaticRules.stderr).not.toContain('upload policy rejected')
  })

  it('stores credentials and calls /api/me under Bun', async () => {
    const set = await cli('bun', ['auth', 'set', '--api-url', apiUrl, '--json'], 'ds_integration\n')
    expect(set.exitCode).toBe(0)
    expect(set.stderr).toBe('')
    expect(JSON.parse(set.stdout)).toEqual({ ok: true, origin: apiUrl })

    const me = await cli('bun', ['whoami', '--json'])
    expect(me.exitCode).toBe(0)
    expect(me.stderr).toBe('')
    expect(JSON.parse(me.stdout)).toEqual({
      ok: true,
      account: { id: 'acct_test', name: 'Test User' },
      workspace: { id: 'ws_test', slug: 'test', role: 'admin' },
    })

    const logout = await cli('node', ['--json', 'auth', 'logout'])
    expect(logout.exitCode).toBe(0)
    expect(logout.stderr).toBe('')
    expect(JSON.parse(logout.stdout)).toEqual({ ok: true, origin: apiUrl, removed: true })
  })
})
