import { scanStateFields } from '@dossier/policy'
import {
  expect,
  request as apiRequest,
  test,
  type APIRequestContext,
} from '@playwright/test'

const baseURL = process.env.DOSSIER_BROWSER_BASE_URL ?? 'http://localhost:8790'
const apiKey = process.env.DOSSIER_BROWSER_API_KEY ?? ''

/**
 * The document the first spec reads. It carries one field of every shape the
 * wrapper has to fill in: a text input, a checkbox, a textarea, and a custom
 * control that only exists once its own script has registered it.
 */
const SAVED_VALUES_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Launch plan</title>
</head>
<body>
<h1 id="heading">Launch plan</h1>
<label>Objective <input data-state="objective" value="Launch the new website"></label>
<label><input type="checkbox" data-state="approved"> Design approved</label>
<label>Notes <textarea data-state="notes"></textarea></label>
<section data-state="decisions" data-state-default='{"owner":"unassigned","votes":0}'>
  <p id="decision-owner">unassigned</p>
  <p id="decision-votes">0</p>
</section>
<script>
;(() => {
  let decisions = { owner: 'unassigned', votes: 0 }
  const owner = document.getElementById('decision-owner')
  const votes = document.getElementById('decision-votes')
  const render = () => {
    owner.textContent = String(decisions.owner)
    votes.textContent = String(decisions.votes)
  }
  window.dossierState.register({
    name: 'decisions',
    read: () => decisions,
    write: (value) => {
      decisions = value
      render()
    },
  })
  document.addEventListener('dossier:state-applied', () => {
    document.body.dataset.applied = 'yes'
  })
})()
</script>
</body>
</html>
`

/**
 * Every error-free fixture from packages/policy/src/state.test.ts. They go into
 * one document with their names prefixed, so a single page load compares the
 * scanner's default with the browser's live value for all of them.
 */
const SCAN_FIXTURES: readonly { readonly id: string; readonly body: string }[] =
  [
    {
      id: 'text',
      body: `
        <input data-state="title" value="  Launch  ">
        <input data-state="empty">
        <input data-state="lines" value="first
second">
      `,
    },
    {
      id: 'textarea',
      body: '<textarea data-state="notes">\nfirst\nsecond</textarea>',
    },
    {
      id: 'number',
      body: `
        <input type="number" data-state="zero" value="0">
        <input type="number" data-state="decimal" value="-.5e2">
        <input type="number" data-state="empty" value="">
        <input type="number" data-state="invalid" value="12px">
        <input type="number" data-state="overflow" value="1e999">
      `,
    },
    {
      id: 'date',
      body: `
        <input type="date" data-state="valid" value="2028-02-29">
        <input type="date" data-state="invalid" value="2027-02-29">
      `,
    },
    {
      id: 'checkbox',
      body: `
        <input type="checkbox" data-state="approved" checked="false">
        <input type="checkbox" data-state="reviewed">
      `,
    },
    {
      id: 'radio',
      body: `
        <input type="radio" data-state="decision" value="no">
        <input type="radio" data-state="decision" value="yes" checked>
        <input type="radio" data-state="implicit" checked>
        <input type="radio" data-state="unselected" value="later">
      `,
    },
    {
      id: 'multiple',
      body: `
        <select data-state="owners" multiple>
          <option value="one" selected>One</option>
          <option>  two\n words  </option>
          <option selected>  three\n words  </option>
        </select>
      `,
    },
    {
      id: 'nbsp',
      body: '<select data-state="choice"><option>&nbsp;x&nbsp;</option></select>',
    },
    {
      id: 'lastselected',
      body: `
        <select data-state="priority">
          <option value="low" selected>Low</option>
          <option value="high" selected>High</option>
        </select>
      `,
    },
    {
      id: 'disabledfirst',
      body: `
        <select data-state="priority">
          <option value="placeholder" disabled>Choose</option>
          <option value="normal">Normal</option>
        </select>
      `,
    },
    {
      id: 'optgroup',
      body: `
        <select data-state="priority">
          <optgroup label="Old" disabled>
            <option value="old">Old</option>
          </optgroup>
          <optgroup label="Current">
            <option value="current">Current</option>
          </optgroup>
        </select>
      `,
    },
    {
      id: 'alldisabled',
      body: `
        <select data-state="priority">
          <option disabled value="one">One</option>
          <optgroup disabled><option value="two">Two</option></optgroup>
        </select>
      `,
    },
    {
      id: 'sized',
      body: `
        <select data-state="priority" size="2">
          <option value="one">One</option>
          <option value="two">Two</option>
        </select>
      `,
    },
    {
      id: 'json',
      body: `
        <section data-state="decisions"
          data-state-default='{"approved":true,"votes":[1,2]}'>
        </section>
        <div data-state="unset"></div>
      `,
    },
    {
      id: 'skipped',
      body: `
        <input data-state="first" value="one">
        <template><input data-state="template" value="hidden"></template>
        <svg>
          <foreignObject>
            <input data-state="foreign" value="hidden">
          </foreignObject>
        </svg>
        <input data-state="last" value="two">
      `,
    },
  ]

/**
 * A custom control that takes its value from data-state-default, which is what
 * the manifest holds for a json field. Anything the scanner treats as a custom
 * field is registered here, so collect can answer for it.
 */
const REGISTER_CUSTOM_FIELDS = `
;(() => {
  const CONTROLS = new Set(['input', 'textarea', 'select'])
  for (const element of document.querySelectorAll('[data-state]')) {
    if (CONTROLS.has(element.tagName.toLowerCase())) continue
    if (element.closest('svg')) continue
    const raw = element.getAttribute('data-state-default')
    const value = raw === null ? null : JSON.parse(raw)
    window.dossierState.register({
      name: element.getAttribute('data-state'),
      read: () => value,
      write: () => {},
    })
  }
})()
`

function scanFixtureDocument(): string {
  const sections = SCAN_FIXTURES.map(
    ({ id, body }) =>
      `<section data-fixture="${id}">${body.replaceAll(
        'data-state="',
        `data-state="${id}.`,
      )}</section>`,
  ).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Scanner fixtures</title>
</head>
<body>
${sections}
<script>${REGISTER_CUSTOM_FIELDS}</script>
</body>
</html>
`
}

interface PublishedDocument {
  readonly id: string
  readonly version: number
}

async function publish(
  api: APIRequestContext,
  input: { readonly html: string; readonly documentId?: string },
): Promise<PublishedDocument> {
  const response = await api.post('/api/uploads', {
    headers: { authorization: `Bearer ${apiKey}` },
    data: {
      html: input.html,
      stateful: true,
      visibility: 'public',
      kind: 'plan',
      ...(input.documentId === undefined
        ? {}
        : { documentId: input.documentId }),
    },
  })
  // A new document answers 201, a new version of an existing one answers 200.
  expect([200, 201], await response.text()).toContain(response.status())
  const body = (await response.json()) as {
    readonly document: { readonly id: string }
    readonly versionNumber: number
  }
  return { id: body.document.id, version: body.versionNumber }
}

async function save(
  api: APIRequestContext,
  documentId: string,
  values: Readonly<Record<string, unknown>>,
): Promise<void> {
  const response = await api.put(`/api/documents/${documentId}/state`, {
    headers: { authorization: `Bearer ${apiKey}` },
    data: {
      changes: Object.entries(values).map(([name, value]) => ({
        name,
        value,
        base: 0,
      })),
    },
  })
  expect(response.status(), await response.text()).toBe(200)
}

async function frameTicket(
  api: APIRequestContext,
  documentId: string,
): Promise<string> {
  const response = await api.get(`/d/${documentId}/state`)
  expect(response.status(), await response.text()).toBe(200)
  const body = (await response.json()) as { readonly frameTicket: string }
  return body.frameTicket
}

let saved: PublishedDocument
let fixtures: PublishedDocument

test.beforeAll(async () => {
  expect(apiKey, 'global setup must export DOSSIER_BROWSER_API_KEY').not.toBe(
    '',
  )
  const api = await apiRequest.newContext({ baseURL })
  saved = await publish(api, { html: SAVED_VALUES_HTML })
  await save(api, saved.id, {
    objective: 'Ship in October',
    approved: true,
    notes: 'from the CLI',
    decisions: { owner: 'ada', votes: 3 },
  })
  // A second version, so /v/1 is genuinely an older version.
  await publish(api, {
    html: SAVED_VALUES_HTML.replace('Launch plan</h1>', 'Launch plan v2</h1>'),
    documentId: saved.id,
  })
  fixtures = await publish(api, { html: scanFixtureDocument() })
  await api.dispose()
})

test('fills marked inputs and a registered custom field from a CLI save', async ({
  page,
}) => {
  await page.goto(`/d/${saved.id}`)

  // The seeded session cookie reached the Worker, so this is the account mode.
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'account')
  await expect(page.locator('#dossier-status')).toHaveText('Read only')
  await expect(page.locator('#dossier-save')).toBeDisabled()
  await expect(page.locator('#dossier-overlay')).toBeHidden()

  const frame = page.frameLocator('#dossier-frame')
  await expect(frame.locator('[data-state="objective"]')).toHaveValue(
    'Ship in October',
  )
  await expect(frame.locator('[data-state="approved"]')).toBeChecked()
  await expect(frame.locator('[data-state="notes"]')).toHaveValue(
    'from the CLI',
  )
  await expect(frame.locator('#decision-owner')).toHaveText('ada')
  await expect(frame.locator('#decision-votes')).toHaveText('3')
  // The runtime dispatched dossier:state-applied after writing every field.
  await expect(frame.locator('body')).toHaveAttribute('data-applied', 'yes')
})

test('serves the same values to an anonymous reader of a public document', async ({
  browser,
}) => {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  })
  const page = await context.newPage()
  await page.goto(`${baseURL}/d/${saved.id}`)

  await expect(page.locator('body')).toHaveAttribute('data-mode', 'public')
  await expect(page.locator('#dossier-status')).toHaveText('Read only')
  await expect(page.locator('#dossier-overlay')).toBeHidden()
  await expect(
    page.frameLocator('#dossier-frame').locator('[data-state="objective"]'),
  ).toHaveValue('Ship in October')
  await context.close()
})

test('keeps a silent frame inaccessible and retries with a fresh ticket', async ({
  page,
}) => {
  let frameTicketSeen: string | null = null
  let refreshRequests = 0
  await page.route(`**/d/${saved.id}/state`, async (route) => {
    refreshRequests += 1
    const response = await route.fetch()
    const surface = (await response.json()) as Record<string, unknown>
    await route.fulfill({
      response,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ ...surface, frameTicket: 'fresh-ticket' }),
    })
  })
  // A frame that loads but carries no runtime: the wrapper waits five seconds
  // and then offers a retry rather than showing the author's defaults.
  await page.route('**/frame?*', (route) => {
    frameTicketSeen = new URL(route.request().url()).searchParams.get('t')
    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><head><title>silent</title></head><body><input id="authored-default"></body></html>',
    })
  })
  await page.goto(`/d/${saved.id}`)

  const frame = page.locator('#dossier-frame')
  const loading = page.locator('#dossier-overlay-loading')
  await expect(loading).toHaveAttribute('role', 'status')
  await expect(loading).toHaveText('Loading saved values…')
  await expect(loading).toBeVisible()
  await expect(frame).toHaveAttribute('inert', '')
  await expect(frame).toHaveAttribute('aria-hidden', 'true')
  await page.evaluate(() => document.getElementById('dossier-frame')?.focus())
  await expect(frame).not.toBeFocused()

  const failure = page.locator('#dossier-overlay-error')
  await expect(failure).toHaveAttribute('role', 'alert')
  await expect(failure).toContainText('Could not load the saved values')
  await expect(failure).toBeVisible({ timeout: 10_000 })
  await expect(loading).toBeHidden()
  await expect(page.locator('#dossier-retry')).toBeFocused()
  const initialTicket = frameTicketSeen
  expect(initialTicket).not.toBeNull()
  expect(initialTicket).not.toBe('fresh-ticket')

  await page.locator('#dossier-retry').click()
  await expect(loading).toBeVisible()
  await expect(page.locator('#dossier-overlay-error')).toBeHidden()
  await expect(frame).toHaveAttribute('inert', '')
  await expect.poll(() => refreshRequests).toBe(1)
  await expect.poll(() => frameTicketSeen).toBe('fresh-ticket')
})

test('reads a pinned version as an older version', async ({ page }) => {
  await page.goto(`/d/${saved.id}/v/1`)

  await expect(page.locator('#dossier-status')).toHaveText(
    'Older version, read only',
  )
  await expect(page.locator('#dossier-save')).toBeDisabled()
  await expect(page.locator('#dossier-overlay')).toBeHidden()

  const frame = page.frameLocator('#dossier-frame')
  // Version 1's bytes, filled with the current saved values.
  await expect(frame.locator('#heading')).toHaveText('Launch plan')
  await expect(frame.locator('[data-state="objective"]')).toHaveValue(
    'Ship in October',
  )
})

test('rejects state controls whose values Chromium sanitizes by input type', async ({
  page,
}) => {
  const types = [
    'color',
    'range',
    'email',
    'url',
    'time',
    'month',
    'week',
    'datetime-local',
  ] as const
  const controls = types
    .map(
      (type) => `<input type="${type}" data-state="${type}" value=" invalid ">`,
    )
    .join('')
  const html = `<!doctype html><html><head><title>Sanitized inputs</title></head><body>${controls}</body></html>`
  const scan = scanStateFields(html)

  expect(scan.fields).toEqual([])
  expect(scan.errors).toHaveLength(types.length)
  await page.setContent(controls)
  const sanitized = await page.locator('input').evaluateAll((inputs) =>
    inputs.map((input) => ({
      type: input.getAttribute('type'),
      attribute: input.getAttribute('value'),
      value: (input as HTMLInputElement).value,
    })),
  )
  expect(sanitized.every((input) => input.value !== input.attribute)).toBe(true)
})

test('keeps the read-only status legible without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/d/${saved.id}`)
  await expect(page.locator('#dossier-overlay')).toBeHidden()

  const layout = await page.evaluate(() => ({
    fontSize: Number.parseFloat(
      getComputedStyle(document.getElementById('dossier-status')!).fontSize,
    ),
    viewportWidth: document.documentElement.clientWidth,
    contentWidth: document.documentElement.scrollWidth,
  }))
  expect(layout.fontSize).toBeGreaterThanOrEqual(12)
  expect(layout.contentWidth).toBeLessThanOrEqual(layout.viewportWidth)
})

test('scanned defaults equal what Chromium reports for every fixture', async ({
  page,
}) => {
  const html = scanFixtureDocument()
  const scan = scanStateFields(html)
  expect(scan.errors).toEqual([])
  const expected = Object.fromEntries(
    scan.fields.map((field) => [field.name, field.default]),
  )
  // Guards the comparison below against silently matching two empty objects.
  expect(scan.fields.length).toBeGreaterThanOrEqual(20)
  expect(expected).not.toHaveProperty('skipped.template')
  expect(expected).not.toHaveProperty('skipped.foreign')

  const api = await apiRequest.newContext({ baseURL })
  const ticket = await frameTicket(api, fixtures.id)
  await api.dispose()

  // The frame runtime answers a collect with every field whose value differs
  // from its memory. Nothing has been applied here, so that is every field,
  // read straight out of Chromium.
  await page.goto(`/d/${fixtures.id}/frame?t=${encodeURIComponent(ticket)}`)
  const actual = await page.evaluate(
    (documentId) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('the frame runtime never answered collect')),
          10_000,
        )
        window.addEventListener('message', (event) => {
          const data = event.data as {
            type?: string
            documentId?: string
            fields?: unknown
          }
          if (data?.type !== 'values' || data.documentId !== documentId) return
          clearTimeout(timer)
          resolve(data.fields)
        })
        window.postMessage({ type: 'collect', documentId }, '*')
      }),
    fixtures.id,
  )

  expect(actual).toEqual(expected)
})
