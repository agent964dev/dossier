'use strict'

const fs = require('node:fs')
const path = require('node:path')

const {
  BASE_URL,
  BROWSER_DIR,
  assert,
  browserLaunchOptions,
  cspConsoleMessages,
  loadPlaywright,
  parseArgs,
  readFixture,
  requestRecord,
  requireApiKey,
  startServer,
  stopServer,
  uploadPublicDocument,
  writeJson,
} = require('./lib.cjs')

const ALLOWED_URL = 'https://example.com/'
const BLOCKED_URL = 'https://example.org/'
const ALLOWED_ORIGIN = new URL(ALLOWED_URL).origin

function frameSources(csp) {
  const directive = csp
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('frame-src '))
  return directive ? directive.split(/\s+/).slice(1) : []
}

async function waitFor(probe, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError}` : ''}`)
}

async function runSameOriginBrowser(engine, browserType, documentId, innerDocumentId) {
  const record = { engine, status: 'failed' }
  let browser
  let context
  try {
    browser = await browserType.launch(browserLaunchOptions(engine))
    record.version = browser.version()
    context = await browser.newContext()
    await context.addCookies([
      {
        name: 'dossier_session',
        value: 'browser-embed-session-probe',
        url: BASE_URL,
        httpOnly: true,
        sameSite: 'Lax',
        secure: BASE_URL.startsWith('https:'),
      },
      {
        name: 'dossier_sandbox_probe',
        value: 'readable-outside-sandbox',
        url: BASE_URL,
        httpOnly: false,
        sameSite: 'Lax',
        secure: BASE_URL.startsWith('https:'),
      },
    ])

    const page = await context.newPage()
    const consoleMessages = []
    const innerRequests = []
    page.on('console', (message) => {
      consoleMessages.push({ type: message.type(), text: message.text() })
    })
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname
      if (pathname === `/d/${innerDocumentId}`) {
        innerRequests.push(requestRecord(request))
      }
    })

    const response = await page.goto(`${BASE_URL}/d/${documentId}`, {
      waitUntil: 'load',
      timeout: 45_000,
    })
    assert(response, `${engine}: outer document navigation returned no response.`)
    assert(response.status() === 200, `${engine}: outer document returned HTTP ${response.status()}.`)
    const csp = response.headers()['content-security-policy'] || ''
    const sources = frameSources(csp)
    const baseOrigin = new URL(BASE_URL).origin
    const externalSources = sources.filter((source) => /^https?:/.test(source) && source !== baseOrigin)
    assert(sources.includes(baseOrigin), `${engine}: frame-src does not include ${baseOrigin}: ${csp}`)
    assert(externalSources.length === 0, `${engine}: empty allowlist exposed external frame sources: ${externalSources.join(', ')}`)

    const innerFrame = await waitFor(
      () => page.frames().find((frame) => {
        try {
          return new URL(frame.url()).pathname === `/d/${innerDocumentId}`
        } catch {
          return false
        }
      }),
      `${engine} nested Dossier document frame`,
    )
    await innerFrame.waitForFunction(() => globalThis.__dossierInnerProbe?.scriptRan === true)
    const innerProbe = await innerFrame.evaluate(() => globalThis.__dossierInnerProbe)
    const resolvedInnerRequests = await Promise.all(innerRequests)
    const innerCookieHeaders = resolvedInnerRequests
      .map((request) => request.headers.cookie)
      .filter((value) => value !== undefined)
    const consoleViolations = cspConsoleMessages(consoleMessages)
    const probeCookieReadable = innerProbe.cookieResult?.value?.includes('dossier_sandbox_probe=') === true
    const sessionCookieSent = innerCookieHeaders.some((header) => header.includes('dossier_session='))

    record.navigation = {
      status: response.status(),
      contentSecurityPolicy: csp,
      frameSources: sources,
      frameCount: page.frames().length,
    }
    record.console = consoleMessages
    record.inner = {
      url: innerFrame.url(),
      probe: innerProbe,
      requests: resolvedInnerRequests,
    }
    record.findings = {
      nestedFramesInheritSandbox: innerProbe.origin === 'null' && innerProbe.parentReadable === false,
      innerSameOriginFrameCanReadCookies: probeCookieReadable,
      sessionCookieSentOnInnerNavigation: sessionCookieSent,
    }
    record.assertions = {
      innerScriptRan: innerProbe.scriptRan === true,
      nestedFrameOriginIsOpaque: innerProbe.origin === 'null',
      nestedFrameCannotReadParent: innerProbe.parentReadable === false,
      nestedFrameCannotReadProbeCookie: probeCookieReadable === false,
      sessionCookieNotSentOnInnerNavigation: sessionCookieSent === false,
      nestedFrameRequestObserved: resolvedInnerRequests.length > 0,
      frameCount: page.frames().length >= 2,
      noUnexpectedCspViolation: consoleViolations.length === 0,
    }
    const failures = Object.entries(record.assertions)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
    assert(failures.length === 0, `${engine}: failed same-origin assertions: ${failures.join(', ')}`)
    record.status = 'passed'
  } catch (error) {
    record.error = String(error?.stack || error)
  } finally {
    await context?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
  }
  return record
}

async function runAllowlistedBrowser(engine, browserType, documentId) {
  const record = { engine, status: 'failed' }
  let browser
  let context
  try {
    browser = await browserType.launch(browserLaunchOptions(engine))
    record.version = browser.version()
    context = await browser.newContext()
    const page = await context.newPage()
    const consoleMessages = []
    const frameNavigations = []
    page.on('console', (message) => {
      consoleMessages.push({ type: message.type(), text: message.text() })
    })
    page.on('framenavigated', (frame) => {
      frameNavigations.push({ name: frame.name(), url: frame.url() })
    })

    const response = await page.goto(`${BASE_URL}/d/${documentId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    })
    assert(response, `${engine}: allowlisted document navigation returned no response.`)
    assert(response.status() === 200, `${engine}: allowlisted document returned HTTP ${response.status()}.`)
    const csp = response.headers()['content-security-policy'] || ''
    const sources = frameSources(csp)
    assert(sources.includes(ALLOWED_ORIGIN), `${engine}: frame-src does not include ${ALLOWED_ORIGIN}: ${csp}`)

    await waitFor(
      () => frameNavigations.some((entry) => entry.url.startsWith(ALLOWED_ORIGIN)),
      `${engine} allowlisted frame navigation`,
      30_000,
    )
    await page.waitForFunction(
      (blockedOrigin) => (globalThis.__dossierCspViolations || []).some(
        (violation) => violation.effectiveDirective === 'frame-src' &&
          violation.blockedURI.startsWith(blockedOrigin),
      ),
      new URL(BLOCKED_URL).origin,
      { timeout: 20_000 },
    )

    const violations = await page.evaluate(
      () => globalThis.__dossierCspViolations || [],
    )
    const allowedFrame = page.frames().find((frame) => frame.url().startsWith(ALLOWED_ORIGIN))
    let allowedFrameOrigin = null
    let allowedFrameOriginError = null
    if (allowedFrame) {
      try {
        allowedFrameOrigin = await allowedFrame.evaluate(() => window.origin)
      } catch (error) {
        allowedFrameOriginError = String(error)
      }
    }
    const blockedOrigin = new URL(BLOCKED_URL).origin
    const blockedViolation = violations.find((violation) =>
      violation.effectiveDirective === 'frame-src' && violation.blockedURI.startsWith(blockedOrigin),
    )

    record.navigation = {
      status: response.status(),
      contentSecurityPolicy: csp,
      frameSources: sources,
      frameCount: page.frames().length,
      frameNavigations,
    }
    record.console = consoleMessages
    record.allowedFrame = {
      expectedOrigin: ALLOWED_ORIGIN,
      finalUrl: allowedFrame?.url() || null,
      originInsideFrame: allowedFrameOrigin,
      originInspectionError: allowedFrameOriginError,
    }
    record.blockedFrame = {
      expectedOrigin: blockedOrigin,
      violation: blockedViolation || null,
      allViolations: violations,
    }
    record.findings = {
      allowlistedFrameNavigated: frameNavigations.some((entry) => entry.url.startsWith(ALLOWED_ORIGIN)),
      allowlistedNestedFrameInheritsSandbox: allowedFrameOrigin === 'null',
      nonAllowlistedFrameBlockedByCsp: Boolean(blockedViolation),
    }
    record.assertions = {
      frameCount: page.frames().length >= 2,
      allowlistedFrameNavigated: record.findings.allowlistedFrameNavigated,
      allowlistedFramePresent: Boolean(allowedFrame),
      nonAllowlistedFrameBlockedByCsp: record.findings.nonAllowlistedFrameBlockedByCsp,
    }
    const failures = Object.entries(record.assertions)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
    assert(failures.length === 0, `${engine}: failed allowlisted assertions: ${failures.join(', ')}`)
    record.status = 'passed'
  } catch (error) {
    record.error = String(error?.stack || error)
  } finally {
    await context?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
  }
  return record
}

async function runEmptyCase(apiKey, playwright) {
  const innerHtml = readFixture('embed-inner.html')
  const innerUpload = await uploadPublicDocument(
    apiKey,
    innerHtml,
    `browser-embed-inner-${Date.now()}.html`,
  )
  const outerHtml = readFixture('embed-same-origin.html', {
    INNER_URL: `/d/${innerUpload.document.id}`,
  })
  const outerUpload = await uploadPublicDocument(
    apiKey,
    outerHtml,
    `browser-embed-outer-${Date.now()}.html`,
  )
  const browsers = []
  for (const [engine, browserType] of [['chromium', playwright.chromium], ['webkit', playwright.webkit]]) {
    browsers.push(await runSameOriginBrowser(
      engine,
      browserType,
      outerUpload.document.id,
      innerUpload.document.id,
    ))
  }
  return {
    status: browsers.every((browser) => browser.status === 'passed') ? 'passed' : 'failed',
    configuredAllowlist: '',
    documents: {
      inner: { id: innerUpload.document.id, url: `${BASE_URL}/d/${innerUpload.document.id}` },
      outer: { id: outerUpload.document.id, url: `${BASE_URL}/d/${outerUpload.document.id}` },
    },
    browsers,
  }
}

async function runAllowlistedCase(apiKey, playwright) {
  const html = readFixture('embed-allowlisted.html', {
    ALLOWED_URL,
    BLOCKED_URL,
  })
  const upload = await uploadPublicDocument(
    apiKey,
    html,
    `browser-embed-allowlisted-${Date.now()}.html`,
  )
  const browsers = []
  for (const [engine, browserType] of [['chromium', playwright.chromium], ['webkit', playwright.webkit]]) {
    browsers.push(await runAllowlistedBrowser(engine, browserType, upload.document.id))
  }
  return {
    status: browsers.every((browser) => browser.status === 'passed') ? 'passed' : 'failed',
    configuredAllowlist: new URL(ALLOWED_URL).host,
    document: { id: upload.document.id, url: `${BASE_URL}/d/${upload.document.id}` },
    allowedUrl: ALLOWED_URL,
    blockedUrl: BLOCKED_URL,
    browsers,
  }
}

function existingResult() {
  const file = path.join(BROWSER_DIR, 'results', 'embed.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

async function main() {
  const { manageServer, caseName } = parseArgs(process.argv.slice(2))
  assert(['all', 'empty', 'allowlisted'].includes(caseName), '--case must be all, empty, or allowlisted.')
  assert(manageServer || caseName !== 'all', 'Caller-managed mode requires --case empty or --case allowlisted.')

  const prior = manageServer ? null : existingResult()
  const result = {
    status: 'partial',
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    managedServer: manageServer,
    cases: prior?.cases || {},
  }
  const apiKey = requireApiKey()
  const playwright = loadPlaywright()
  const selected = caseName === 'all' ? ['empty', 'allowlisted'] : [caseName]
  let selectedFailed = false

  for (const selectedCase of selected) {
    let server
    try {
      if (manageServer) {
        server = await startServer({
          embedHostAllowlist: selectedCase === 'allowlisted' ? new URL(ALLOWED_URL).host : '',
        })
      }
      result.cases[selectedCase] = selectedCase === 'empty'
        ? await runEmptyCase(apiKey, playwright)
        : await runAllowlistedCase(apiKey, playwright)
      if (result.cases[selectedCase].status !== 'passed') selectedFailed = true
    } catch (error) {
      selectedFailed = true
      result.cases[selectedCase] = {
        status: 'failed',
        configuredAllowlist: selectedCase === 'allowlisted' ? new URL(ALLOWED_URL).host : '',
        error: String(error?.stack || error),
      }
    } finally {
      await stopServer(server)
      writeJson('embed.json', {
        ...result,
        status: selectedFailed ? 'failed' : 'partial',
        updatedAt: new Date().toISOString(),
      })
    }
  }

  const complete = result.cases.empty && result.cases.allowlisted
  result.status = selectedFailed
    ? 'failed'
    : complete && result.cases.empty.status === 'passed' && result.cases.allowlisted.status === 'passed'
      ? 'passed'
      : 'partial'
  result.finishedAt = new Date().toISOString()
  const output = writeJson('embed.json', result)
  console.log(`Wrote ${output}`)

  if (selectedFailed) {
    console.error('Embed spike failed; inspect results/embed.json.')
    process.exitCode = 1
  }
}

main().catch((error) => {
  const result = {
    status: 'failed',
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    error: String(error?.stack || error),
  }
  const output = writeJson('embed.json', result)
  console.error(`Wrote ${output}\n${result.error}`)
  process.exitCode = 1
})
