'use strict'

const fs = require('node:fs')
const path = require('node:path')

const {
  BASE_URL,
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
} = require('./lib.cjs')

const REPO_DIR = path.resolve(__dirname, '../../..')
const FONT_SOURCE =
  process.env.DOSSIER_FONT_SOURCE ||
  path.resolve(__dirname, '../../../packages/cli/test/fixtures/test-font.woff2')
const BACKGROUND_COLOR = 'oklch(0.62 0.14 240)'
const FONT_FAMILY = 'Dossier Browser Probe'
const BLOCKED_NAVIGATION_URL = 'https://example.com/dossier-navigation-probe'

async function fetchAsset(url, expectedContentType) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
      const bytes = Buffer.from(await response.arrayBuffer())
      assert(
        response.status === 200,
        `${url} returned HTTP ${response.status}.`,
      )
      assert(bytes.length > 0, `${url} returned an empty body.`)
      const contentType = response.headers.get('content-type') || ''
      assert(
        contentType.startsWith(expectedContentType),
        `${url} returned Content-Type ${contentType}.`,
      )
      return {
        url,
        status: response.status,
        bytes: bytes.length,
        headers: Object.fromEntries(response.headers),
        attempts: attempt,
      }
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  throw new Error(`Asset preflight failed for ${url}: ${lastError}`)
}

async function runBrowser(
  engine,
  browserType,
  documentId,
  styleSlug,
  navigationDocumentId,
) {
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
        value: 'browser-render-probe',
        url: BASE_URL,
        httpOnly: true,
        sameSite: 'Lax',
        secure: BASE_URL.startsWith('https:'),
      },
    ])

    const page = await context.newPage()
    const consoleMessages = []
    const styleRequests = []
    page.on('console', (message) => {
      consoleMessages.push({ type: message.type(), text: message.text() })
    })
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === `/a/${styleSlug}.css`) {
        styleRequests.push(requestRecord(request))
      }
    })

    const response = await page.goto(`${BASE_URL}/d/${documentId}`, {
      waitUntil: 'load',
      timeout: 45_000,
    })
    assert(response, `${engine}: document navigation returned no response.`)
    assert(
      response.status() === 200,
      `${engine}: document navigation returned HTTP ${response.status()}.`,
    )

    const rendering = await page.evaluate(
      async ({ backgroundColor, fontFamily }) => {
        let fontLoadError = null
        try {
          await Promise.race([
            (async () => {
              await document.fonts.load(`16px "${fontFamily}"`, 'Dossier')
              await document.fonts.ready
            })(),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error('Timed out loading the probe font.')),
                20_000,
              ),
            ),
          ])
        } catch (error) {
          fontLoadError = String(error)
        }

        const probe = document.createElement('span')
        probe.style.backgroundColor = backgroundColor
        document.documentElement.appendChild(probe)
        const expectedBackground = getComputedStyle(probe).backgroundColor
        probe.remove()

        const faces = [...document.fonts].map((face) => ({
          family: face.family,
          status: face.status,
          style: face.style,
          weight: face.weight,
        }))
        return {
          actualBackground: getComputedStyle(document.body).backgroundColor,
          expectedBackground,
          fontCheck: document.fonts.check(`16px "${fontFamily}"`),
          fontLoadError,
          faces,
          origin: window.origin,
          cspViolations: globalThis.__dossierCspViolations || [],
        }
      },
      { backgroundColor: BACKGROUND_COLOR, fontFamily: FONT_FAMILY },
    )

    const resolvedStyleRequests = await Promise.all(styleRequests)
    const stylesheetCookieHeaders = resolvedStyleRequests
      .map((request) => request.headers.cookie)
      .filter((value) => value !== undefined)
    const consoleViolations = cspConsoleMessages(consoleMessages)
    const matchingFace = rendering.faces.find(
      (face) => face.family.replaceAll('"', '') === FONT_FAMILY,
    )

    const csp = response.headers()['content-security-policy'] || ''
    record.navigation = {
      status: response.status(),
      url: response.url(),
      contentSecurityPolicy: csp,
    }
    record.console = consoleMessages
    record.assertions = {
      background: {
        source: BACKGROUND_COLOR,
        expectedComputed: rendering.expectedBackground,
        actualComputed: rendering.actualBackground,
        passed: rendering.actualBackground === rendering.expectedBackground,
      },
      font: {
        family: FONT_FAMILY,
        check: rendering.fontCheck,
        loadError: rendering.fontLoadError,
        matchingFace: matchingFace || null,
        faces: rendering.faces,
        passed:
          rendering.fontCheck === true && matchingFace?.status === 'loaded',
      },
      csp: {
        consoleViolations,
        eventViolations: rendering.cspViolations,
        passed:
          consoleViolations.length === 0 &&
          rendering.cspViolations.length === 0,
      },
      stylesheetCookie: {
        requests: resolvedStyleRequests,
        cookieHeaders: stylesheetCookieHeaders,
        passed:
          resolvedStyleRequests.length > 0 &&
          stylesheetCookieHeaders.length === 0,
      },
      opaqueOrigin: {
        actual: rendering.origin,
        expected: 'null',
        passed: rendering.origin === 'null',
      },
    }

    const navigationPage = await context.newPage()
    const navigationConsole = []
    const externalRequests = []
    const frameNavigations = []
    navigationPage.on('console', (message) => {
      navigationConsole.push({ type: message.type(), text: message.text() })
    })
    navigationPage.on('request', (request) => {
      if (request.url().startsWith(new URL(BLOCKED_NAVIGATION_URL).origin)) {
        externalRequests.push(requestRecord(request))
      }
    })
    navigationPage.on('framenavigated', (frame) => {
      frameNavigations.push({
        url: frame.url(),
        main: frame === navigationPage.mainFrame(),
      })
    })
    const navigationResponse = await navigationPage.goto(
      `${BASE_URL}/d/${navigationDocumentId}`,
      { waitUntil: 'load', timeout: 45_000 },
    )
    assert(
      navigationResponse,
      `${engine}: navigation probe document returned no response.`,
    )
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const resolvedExternalRequests = await Promise.all(externalRequests)
    const navigationViolations = cspConsoleMessages(navigationConsole)
    const stayedOnDocument =
      navigationPage.url() === `${BASE_URL}/d/${navigationDocumentId}`
    // Informational only: whether a document's own `location = <external URL>`
    // script self-navigates the top-level page. This is a plain record, not a
    // pass/fail gate — whether that should be blocked is an open owner
    // decision (see README "Known open question").
    record.navigationObservation = {
      target: BLOCKED_NAVIGATION_URL,
      finalUrl: navigationPage.url(),
      stayedOnDocument,
      frameNavigations,
      externalRequests: resolvedExternalRequests,
      console: navigationConsole,
      cspViolations: navigationViolations,
    }

    const failures = Object.entries(record.assertions)
      .filter(([, assertion]) => !assertion.passed)
      .map(([name]) => name)
    assert(
      failures.length === 0,
      `${engine}: failed assertions: ${failures.join(', ')}`,
    )
    record.status = 'passed'
  } catch (error) {
    record.error = String(error?.stack || error)
  } finally {
    await context?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
  }
  return record
}

async function main() {
  const { manageServer } = parseArgs(process.argv.slice(2))
  const result = {
    status: 'failed',
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    managedServer: manageServer,
    fontSource: path.relative(REPO_DIR, FONT_SOURCE),
    browsers: [],
  }
  let server

  try {
    const apiKey = requireApiKey()
    if (manageServer) server = await startServer({ embedHostAllowlist: '' })

    assert(
      fs.existsSync(FONT_SOURCE),
      `Required WOFF2 fixture is missing: ${FONT_SOURCE}`,
    )
    const fontBytes = fs.readFileSync(FONT_SOURCE)
    assert(
      fontBytes.subarray(0, 4).toString('ascii') === 'wOF2',
      `${FONT_SOURCE} is not a WOFF2 file.`,
    )

    const fontSlug = randomSlug('browser-font')
    const styleSlug = randomSlug('browser-theme')
    const fontAsset = await createAsset(apiKey, {
      slug: fontSlug,
      ext: 'woff2',
      bytes: fontBytes,
    })
    const css = readFixture('render.css', {
      FONT_FAMILY,
      FONT_URL: `/a/${fontSlug}.woff2`,
      BACKGROUND_COLOR,
    })
    const styleAsset = await createAsset(apiKey, {
      slug: styleSlug,
      ext: 'css',
      bytes: Buffer.from(css),
    })
    const html = readFixture('render.html', {
      STYLE_URL: `/a/${styleSlug}.css`,
    })
    const upload = await uploadPublicDocument(
      apiKey,
      html,
      `browser-render-${Date.now()}.html`,
    )
    const navigationHtml = readFixture('navigation.html', {
      BLOCKED_NAVIGATION_URL,
    })
    const navigationUpload = await uploadPublicDocument(
      apiKey,
      navigationHtml,
      `browser-navigation-${Date.now()}.html`,
    )

    const fontUrl = `${BASE_URL}/a/${fontSlug}.woff2`
    const stylesheetUrl = `${BASE_URL}/a/${styleSlug}.css`
    const [fontPreflight, stylesheetPreflight] = await Promise.all([
      fetchAsset(fontUrl, 'font/woff2'),
      fetchAsset(stylesheetUrl, 'text/css'),
    ])
    assert(
      fontPreflight.headers['access-control-allow-origin'] === '*',
      `${fontUrl} did not return Access-Control-Allow-Origin: *.`,
    )

    result.assets = {
      font: { slug: fontSlug, response: fontAsset, preflight: fontPreflight },
      stylesheet: {
        slug: styleSlug,
        response: styleAsset,
        preflight: stylesheetPreflight,
      },
    }
    result.document = {
      id: upload.document.id,
      url: `${BASE_URL}/d/${upload.document.id}`,
      receipt: upload,
    }
    result.navigationDocument = {
      id: navigationUpload.document.id,
      url: `${BASE_URL}/d/${navigationUpload.document.id}`,
      receipt: navigationUpload,
    }

    const { chromium, webkit } = loadPlaywright()
    for (const [engine, browserType] of [
      ['chromium', chromium],
      ['webkit', webkit],
    ]) {
      result.browsers.push(
        await runBrowser(
          engine,
          browserType,
          upload.document.id,
          styleSlug,
          navigationUpload.document.id,
        ),
      )
    }
    result.status = result.browsers.every(
      (browser) => browser.status === 'passed',
    )
      ? 'passed'
      : 'failed'
  } catch (error) {
    result.error = String(error?.stack || error)
  } finally {
    await stopServer(server)
    result.finishedAt = new Date().toISOString()
    const output = writeJson('render.json', result)
    console.log(`Wrote ${output}`)
  }

  if (result.status !== 'passed') {
    console.error(
      result.error || 'Render check failed; inspect results/render.json.',
    )
    process.exitCode = 1
  }
}

main()
