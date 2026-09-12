'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const BROWSER_DIR = __dirname
const APP_DIR = path.resolve(BROWSER_DIR, '..')
const REPO_DIR = path.resolve(APP_DIR, '../..')
const BASE_URL = (process.env.DOSSIER_BASE_URL || 'http://localhost:8787').replace(/\/$/, '')
const PLAYWRIGHT_PATH = process.env.DOSSIER_PLAYWRIGHT_PATH || '/opt/homebrew/lib/node_modules/playwright'
const VITE_CONFIG = path.join(BROWSER_DIR, 'vite.browser.config.mjs')

function requireApiKey() {
  const value = process.env.DOSSIER_API_KEY?.trim()
  if (!value) throw new Error('DOSSIER_API_KEY is required.')
  return value
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function randomSlug(prefix) {
  const entropy = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${prefix}-${entropy}`.slice(0, 64)
}

function readFixture(name, replacements = {}) {
  const file = path.join(BROWSER_DIR, 'fixtures', name)
  let value = fs.readFileSync(file, 'utf8')
  for (const [key, replacement] of Object.entries(replacements)) {
    value = value.split(`{{${key}}}`).join(String(replacement))
  }
  const unresolved = value.match(/{{[A-Z0-9_]+}}/g)
  if (unresolved) throw new Error(`Unresolved fixture tokens in ${name}: ${unresolved.join(', ')}`)
  return value
}

async function apiJson(pathname, apiKey, body) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  if (!response.ok) {
    const renderedBody = typeof parsed === 'string' ? parsed : JSON.stringify(parsed)
    throw new Error(`POST ${pathname} failed with HTTP ${response.status}: ${renderedBody}`)
  }
  return parsed
}

async function createAsset(apiKey, { slug, ext, bytes }) {
  return apiJson('/api/assets', apiKey, {
    slug,
    ext,
    contentBase64: Buffer.from(bytes).toString('base64'),
  })
}

async function uploadPublicDocument(apiKey, html, filename) {
  const receipt = await apiJson('/api/uploads', apiKey, {
    html,
    filename,
    visibility: 'public',
  })
  const id = receipt?.document?.id
  assert(typeof id === 'string', `POST /api/uploads returned no document.id: ${JSON.stringify(receipt)}`)
  return receipt
}

function writeJson(name, value) {
  const directory = path.join(BROWSER_DIR, 'results')
  fs.mkdirSync(directory, { recursive: true })
  const target = path.join(directory, name)
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`)
  return target
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function healthResponds(timeoutMs = 700) {
  try {
    const response = await fetch(`${BASE_URL}/api/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

async function startServer({ embedHostAllowlist = '' } = {}) {
  if (await healthResponds()) {
    throw new Error(`${BASE_URL} already has a responding server; omit --manage-server to use it.`)
  }

  const output = []
  const child = spawn(
    'bun',
    ['run', '--cwd', APP_DIR, 'dev', '--', '--config', VITE_CONFIG],
    {
      cwd: REPO_DIR,
      detached: true,
      env: {
        ...process.env,
        DOSSIER_BROWSER_EMBED_HOST_ALLOWLIST: embedHostAllowlist,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const capture = (chunk) => {
    output.push(chunk.toString())
    while (output.join('').length > 24000) output.shift()
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Dev server exited with code ${child.exitCode}.\n${output.join('')}`)
    }
    if (await healthResponds(1000)) {
      return { child, output, embedHostAllowlist }
    }
    await delay(300)
  }

  await stopServer({ child, output })
  throw new Error(`Timed out waiting for ${BASE_URL}/api/healthz.\n${output.join('')}`)
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return
  const child = server.child
  const exited = new Promise((resolve) => child.once('exit', resolve))
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  await Promise.race([exited, delay(5000)])
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
    await Promise.race([exited, delay(2000)])
  }
}

function parseArgs(argv) {
  const flags = new Set(argv)
  let caseName = 'all'
  const caseIndex = argv.indexOf('--case')
  if (caseIndex !== -1) caseName = argv[caseIndex + 1]
  return { manageServer: flags.has('--manage-server'), caseName }
}

function browserLaunchOptions(engine) {
  const options = { headless: true }
  if (engine !== 'webkit') return options
  const candidates = [
    process.env.DOSSIER_WEBKIT_EXECUTABLE,
    '/tmp/dossier-research/csp/webkit-2272/pw_run.sh',
  ].filter(Boolean)
  const executablePath = candidates.find((candidate) => fs.existsSync(candidate))
  return executablePath ? { ...options, executablePath } : options
}

function loadPlaywright() {
  try {
    return require(PLAYWRIGHT_PATH)
  } catch (error) {
    throw new Error(`Could not load Playwright from ${PLAYWRIGHT_PATH}: ${error}`)
  }
}

function cspConsoleMessages(messages) {
  return messages.filter((entry) =>
    /content security policy|refused to (?:load|frame|connect|execute)|violat(?:e|ion)/i.test(entry.text),
  )
}

async function requestRecord(request) {
  let headers = {}
  try {
    headers = await request.allHeaders()
  } catch {
    headers = request.headers()
  }
  return {
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    headers,
  }
}

module.exports = {
  APP_DIR,
  BASE_URL,
  BROWSER_DIR,
  PLAYWRIGHT_PATH,
  apiJson,
  assert,
  browserLaunchOptions,
  createAsset,
  cspConsoleMessages,
  loadPlaywright,
  parseArgs,
  randomSlug,
  readFixture,
  requestRecord,
  requireApiKey,
  startServer,
  stopServer,
  uploadPublicDocument,
  writeJson,
}
