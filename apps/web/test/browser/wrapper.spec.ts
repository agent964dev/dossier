import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanStateFields } from '@dossier/policy'
import {
  expect,
  request as apiRequest,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test'

const baseURL = process.env.DOSSIER_BROWSER_BASE_URL ?? 'http://localhost:8790'
const apiKey = process.env.DOSSIER_BROWSER_API_KEY ?? ''
const authDirectory = path.join(import.meta.dirname, '.auth')
/** The document's author, and the workspace admin seeded beside it. */
const firstStorage = path.join(authDirectory, 'session.json')
const secondStorage =
  process.env.DOSSIER_BROWSER_SECOND_STORAGE ??
  path.join(authDirectory, 'second.json')

/**
 * The phase 5 fixture: two text fields, three checkboxes, and three custom
 * controls registered from script. "comment" never calls the notify() its
 * registration could hook, which is the A16 case.
 */
const REVIEW_PAGE_HTML = readFileSync(
  path.join(import.meta.dirname, 'fixtures', 'review-page.html'),
  'utf8',
)

const REVIEW_PAGE_RETYPE_HTML = REVIEW_PAGE_HTML.replace(
  `    <input
      type="text"
      id="summary"
      data-state="summary"
      value="Ship the wrapper"
    />`,
  `    <textarea id="summary" data-state="summary">Ship newer HTML</textarea>`,
)

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
  input: {
    readonly html: string
    readonly documentId?: string
    readonly acceptStateChanges?: boolean
  },
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
      ...(input.acceptStateChanges === undefined
        ? {}
        : { acceptStateChanges: input.acceptStateChanges }),
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

interface StateSurface {
  readonly revision: number
  readonly frameTicket: string
  readonly fields: Readonly<
    Record<string, { readonly value: unknown; readonly revision: number }>
  >
}

async function readSurface(
  api: APIRequestContext,
  documentId: string,
): Promise<StateSurface> {
  const response = await api.get(`/d/${documentId}/state`)
  expect(response.status(), await response.text()).toBe(200)
  return (await response.json()) as StateSurface
}

/** A CLI-shaped save, based on whatever revision each field is at right now. */
async function save(
  api: APIRequestContext,
  documentId: string,
  values: Readonly<Record<string, unknown>>,
): Promise<void> {
  const surface = await readSurface(api, documentId)
  const response = await api.put(`/api/documents/${documentId}/state`, {
    headers: { authorization: `Bearer ${apiKey}` },
    data: {
      changes: Object.entries(values).map(([name, value]) => ({
        name,
        value,
        base: surface.fields[name]?.revision ?? 0,
      })),
    },
  })
  expect(response.status(), await response.text()).toBe(200)
}

async function frameTicket(
  api: APIRequestContext,
  documentId: string,
): Promise<string> {
  return (await readSurface(api, documentId)).frameTicket
}

/** A review page of its own per test, so no two specs share saved values. */
async function publishReview(): Promise<PublishedDocument> {
  const api = await apiRequest.newContext({ baseURL })
  try {
    return await publish(api, { html: REVIEW_PAGE_HTML })
  } finally {
    await api.dispose()
  }
}

/** A loaded wrapper page on `documentId`, signed in as `storage`. */
async function openReview(
  browser: Browser,
  documentId: string,
  storage: string = firstStorage,
): Promise<Page> {
  const context = await browser.newContext({ storageState: storage })
  const page = await context.newPage()
  await page.goto(`${baseURL}/d/${documentId}`)
  await expect(page.locator('#dossier-overlay')).toBeHidden()
  return page
}

async function expectStatusFits(page: Page): Promise<void> {
  const layout = await page.locator('#dossier-status').evaluate((status) => ({
    clientWidth: status.clientWidth,
    scrollWidth: status.scrollWidth,
    right: status.getBoundingClientRect().right,
    linksInside: [...status.querySelectorAll('a')].every(
      (link) => link.getBoundingClientRect().right <= innerWidth,
    ),
  }))
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth)
  expect(layout.right).toBeLessThanOrEqual(390)
  expect(layout.linksInside).toBe(true)
}

/** Holds every POST open for `delayMs` and reports when one has left. */
async function delaySaves(
  page: Page,
  documentId: string,
  delayMs: number,
): Promise<() => number> {
  let posted = 0
  await page.route(`**/d/${documentId}/state`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    posted += 1
    const response = await route.fetch()
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    await route.fulfill({ response })
  })
  return () => posted
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

  // The seeded session cookie reached the Worker, so this is the account mode,
  // and the account that published the document may save it.
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'account')
  await expect(page.locator('#dossier-status')).toHaveText('Save')
  await expect(page.locator('#dossier-save')).toBeEnabled()
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

test('keeps the status legible at 390 px without horizontal overflow', async ({
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
  await expectStatusFits(page)
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

test('edits, saves, and reopens on the saved values', async ({ page }) => {
  const review = await publishReview()
  await page.goto(`/d/${review.id}`)
  await expect(page.locator('#dossier-overlay')).toBeHidden()

  const status = page.locator('#dossier-status')
  await expect(status).toHaveText('Save')
  await expect(page.locator('#dossier-save')).toBeEnabled()

  const frame = page.frameLocator('#dossier-frame')
  await frame.locator('#summary').fill('Ship on Friday')
  await frame.locator('[data-state="accessibility"]').check()
  await frame.locator('#approve-button').click()
  await expect(status).toHaveText('Unsaved changes')

  await page.locator('#dossier-save').click()
  await expect(status).toHaveText(/^Saved · \d{1,2}:\d{2}/)

  // A new load of the same page, which is what the next person gets (A03).
  await page.reload()
  await expect(page.locator('#dossier-overlay')).toBeHidden()
  await expect(frame.locator('#summary')).toHaveValue('Ship on Friday')
  await expect(frame.locator('[data-state="accessibility"]')).toBeChecked()
  await expect(frame.locator('#approve-state')).toHaveText('approved')
  await expect(status).toHaveText('Save')
})

test('keeps a cleared field and an unchecked box cleared', async ({ page }) => {
  const review = await publishReview()
  await page.goto(`/d/${review.id}`)
  await expect(page.locator('#dossier-overlay')).toBeHidden()

  const frame = page.frameLocator('#dossier-frame')
  await frame.locator('#summary').fill('')
  await frame.locator('#notes').fill('')
  await frame.locator('[data-state="security"]').uncheck()

  await page.locator('#dossier-save').click()
  await expect(page.locator('#dossier-status')).toHaveText(/^Saved · /)

  // The author's defaults are a non-empty summary, non-empty notes, and a
  // ticked security box. None of them may come back (A08).
  await page.reload()
  await expect(page.locator('#dossier-overlay')).toBeHidden()
  await expect(frame.locator('#summary')).toHaveValue('')
  await expect(frame.locator('#notes')).toHaveValue('')
  await expect(frame.locator('[data-state="security"]')).not.toBeChecked()
})

test('lets two people tick different boxes and shows both to each of them', async ({
  browser,
}) => {
  const review = await publishReview()
  const author = await openReview(browser, review.id)
  const admin = await openReview(browser, review.id, secondStorage)
  const authorFrame = author.frameLocator('#dossier-frame')
  const adminFrame = admin.frameLocator('#dossier-frame')

  // The second account is a workspace admin, not the author, and may save.
  await expect(admin.locator('#dossier-save')).toBeEnabled()

  await authorFrame.locator('[data-state="accessibility"]').check()
  await author.locator('#dossier-save').click()
  await expect(author.locator('#dossier-status')).toHaveText(/^Saved · /)

  // The admin loaded before that save and still succeeds: the fields are
  // disjoint, so nothing it touched moved past its baseline (A09, D2).
  await adminFrame.locator('[data-state="performance"]').check()
  await admin.locator('#dossier-save').click()
  await expect(admin.locator('#dossier-status')).toHaveText(/^Saved · /)
  await expect(adminFrame.locator('[data-state="performance"]')).toBeChecked()
  await expect(adminFrame.locator('[data-state="accessibility"]')).toBeChecked()

  // The author's own next save brings the admin's tick down beside its own.
  await Promise.all([
    author.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/d/${review.id}/state`) &&
        response.status() === 200,
    ),
    author.locator('#dossier-save').click(),
  ])
  await expect(authorFrame.locator('[data-state="performance"]')).toBeChecked()
  await expect(
    authorFrame.locator('[data-state="accessibility"]'),
  ).toBeChecked()

  await author.context().close()
  await admin.context().close()
})

test('shows the conflict dialog for one field and keeps the draft', async ({
  browser,
}) => {
  const review = await publishReview()
  const author = await openReview(browser, review.id)
  const admin = await openReview(browser, review.id, secondStorage)
  const authorFrame = author.frameLocator('#dossier-frame')
  const adminFrame = admin.frameLocator('#dossier-frame')

  await adminFrame.locator('#summary').fill('Ship on Friday')
  await adminFrame.locator('#notes').fill('Checked by the second reviewer')
  await admin.locator('#dossier-save').click()
  await expect(admin.locator('#dossier-status')).toHaveText(/^Saved · /)

  await authorFrame.locator('#summary').fill('Ship next month')
  await author.locator('#dossier-save').click()

  const dialog = author.locator('#dossier-conflict')
  await expect(dialog).toBeVisible()
  await expect(author.locator('#dossier-conflict-title')).toHaveText(
    'This plan changed while you were editing',
  )
  await expect(author.locator('#dossier-conflict-body')).toHaveText(
    'Your changes are not saved. Keep or copy your draft before loading the latest saved version.',
  )
  const fields = author.locator('#dossier-conflict-fields')
  await expect(fields).toContainText('summary')
  await expect(fields).toContainText('Ship on Friday')
  await expect(author.locator('#dossier-conflict-keep')).toBeFocused()
  await expect(author.locator('#dossier-status')).not.toContainText('Saved')

  // The modal keeps the keyboard inside itself: tabbing cycles through its own
  // controls and never reaches one behind it, and the page behind is inert.
  const trail: string[] = []
  for (let step = 0; step < 4; step += 1) {
    await author.keyboard.press('Tab')
    trail.push(
      await author.evaluate(() => {
        const open = document.getElementById('dossier-conflict')
        const active = document.activeElement
        if (active === null || active === document.body) return 'browser'
        return open?.contains(active) === true ? 'dialog' : `#${active.id}`
      }),
    )
  }
  expect(trail).toContain('dialog')
  expect(trail.filter((where) => where.startsWith('#'))).toEqual([])
  await author.evaluate(() => document.getElementById('dossier-save')?.focus())
  await expect(author.locator('#dossier-save')).not.toBeFocused()

  await author.locator('#dossier-conflict-keep').click()
  await expect(dialog).toBeHidden()
  await expect(author.locator('#dossier-save')).toBeFocused()
  await expect(author.locator('#dossier-status')).toHaveText('Unsaved changes')
  await expect(authorFrame.locator('#summary')).toHaveValue('Ship next month')

  // Review latest: every clean field takes the other person's values and the
  // draft stays on screen beside them.
  await author.locator('#dossier-save').click()
  await expect(dialog).toBeVisible()
  await author.locator('#dossier-conflict-review').click()
  await expect(dialog).toBeHidden()
  await expect(authorFrame.locator('#notes')).toHaveValue(
    'Checked by the second reviewer',
  )
  await expect(authorFrame.locator('#summary')).toHaveValue('Ship next month')
  await expect(author.locator('#dossier-status')).toHaveText('Unsaved changes')

  await author.context().close()
  await admin.context().close()
})

test('keeps an edit made during a save unsaved without self-conflict', async ({
  page,
}) => {
  const review = await publishReview()
  const posted = await delaySaves(page, review.id, 1200)
  await page.goto(`/d/${review.id}`)
  await expect(page.locator('#dossier-overlay')).toBeHidden()

  const frame = page.frameLocator('#dossier-frame')
  const status = page.locator('#dossier-status')
  await frame.locator('#summary').fill('First edit')
  await page.locator('#dossier-save').click()
  await expect(status).toHaveText('Saving')
  await expect.poll(posted).toBe(1)

  // The request is already away, carrying "First edit".
  await frame.locator('#summary').fill('Second edit')
  await expect(status).toHaveText('Saving')

  await expect(status).toHaveText('Unsaved changes')
  await expect(frame.locator('#summary')).toHaveValue('Second edit')

  // The next save carries the person's own newer value at the revision their
  // own save just wrote, so it never conflicts with itself.
  await page.locator('#dossier-save').click()
  await expect(status).toHaveText(/^Saved · /)
  await expect(page.locator('#dossier-conflict')).toBeHidden()
  expect(posted()).toBe(2)

  await page.reload()
  await expect(page.locator('#dossier-overlay')).toBeHidden()
  await expect(frame.locator('#summary')).toHaveValue('Second edit')
})

test('keeps a silently edited custom field at its baseline and conflicts', async ({
  page,
}) => {
  const review = await publishReview()
  await page.goto(`/d/${review.id}`)
  await expect(page.locator('#dossier-overlay')).toBeHidden()

  // Someone else saves the comment after this page loaded.
  const api = await apiRequest.newContext({ baseURL })
  await save(api, review.id, { comment: 'from the CLI' })
  await api.dispose()

  const posted = await delaySaves(page, review.id, 1200)
  const frame = page.frameLocator('#dossier-frame')
  const status = page.locator('#dossier-status')
  await frame.locator('#summary').fill('Ship on Friday')
  await page.locator('#dossier-save').click()
  await expect.poll(posted).toBe(1)

  // A custom control with no onChange, edited after collect had already run.
  // Nothing announces it, so only the frame's memory knows.
  await frame.locator('#comment-input').fill('mine')

  // The runtime reports it as still dirty, which is the only reason the bar
  // knows not to say Saved.
  await expect(status).toHaveText('Unsaved changes')
  await expect(frame.locator('#comment-input')).toHaveValue('mine')

  // The comment was never submitted and never applied, so it kept the baseline
  // this page loaded, and saving it now conflicts with the save in between.
  await page.locator('#dossier-save').click()
  await expect(page.locator('#dossier-conflict')).toBeVisible()
  const fields = page.locator('#dossier-conflict-fields')
  await expect(fields).toContainText('comment')
  await expect(fields).toContainText('from the CLI')
  await expect(frame.locator('#comment-input')).toHaveValue('mine')
})

test('marks a silently edited custom field unsaved after a conflict', async ({
  page,
}) => {
  const review = await publishReview()
  await page.goto(`/d/${review.id}`)
  await expect(page.locator('#dossier-overlay')).toBeHidden()

  const api = await apiRequest.newContext({ baseURL })
  await save(api, review.id, { comment: 'from the CLI' })
  await api.dispose()

  const frame = page.frameLocator('#dossier-frame')
  await frame.locator('#comment-input').fill('mine')
  await expect(page.locator('#dossier-status')).toHaveText('Save')
  await page.locator('#dossier-save').click()

  const dialog = page.locator('#dossier-conflict')
  await expect(dialog).toBeVisible()
  await expect(page.locator('#dossier-status')).toHaveText('Unsaved changes')
  await page.locator('#dossier-conflict-keep').click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('#dossier-status')).toHaveText('Unsaved changes')
  await expect(frame.locator('#comment-input')).toHaveValue('mine')
})

test('fails the whole collection when a custom field reader throws', async ({
  page,
}) => {
  const review = await publishReview()
  let posts = 0
  await page.route(`**/d/${review.id}/state`, (route) => {
    if (route.request().method() === 'POST') posts += 1
    return route.continue()
  })
  await page.goto(`/d/${review.id}`)
  await expect(page.locator('#dossier-overlay')).toBeHidden()

  const frame = page.frameLocator('#dossier-frame')
  await frame.locator('#summary').fill('Readable draft')
  await frame.locator('#comment-input').fill('Unreadable draft')
  await frame.locator('body').evaluate(() => {
    const fixture = window as unknown as Window & {
      reviewFixture: { setCommentReadFailure(failed: boolean): void }
    }
    fixture.reviewFixture.setCommentReadFailure(true)
  })

  await page.locator('#dossier-save').click()
  await expect(page.locator('#dossier-status')).toHaveText('Could not save')
  await expect(page.locator('#dossier-save-retry')).toBeVisible()
  expect(posts).toBe(0)
  await expect(frame.locator('#summary')).toHaveValue('Readable draft')
  await expect(frame.locator('#comment-input')).toHaveValue('Unreadable draft')

  await frame.locator('body').evaluate(() => {
    const fixture = window as unknown as Window & {
      reviewFixture: { setCommentReadFailure(failed: boolean): void }
    }
    fixture.reviewFixture.setCommentReadFailure(false)
  })
  await page.locator('#dossier-save-retry').click()
  await expect(page.locator('#dossier-status')).toHaveText(/^Saved · /)
  expect(posts).toBe(1)

  await page.reload()
  await expect(page.locator('#dossier-overlay')).toBeHidden()
  await expect(frame.locator('#summary')).toHaveValue('Readable draft')
  await expect(frame.locator('#comment-input')).toHaveValue('Unreadable draft')
})

test('edits, saves, and reloads a field named __proto__', async ({ page }) => {
  const api = await apiRequest.newContext({ baseURL })
  const special = await publish(api, {
    html: `<!doctype html><html lang="en"><head><title>Special field</title></head><body>
      <label>Special <input data-state="__proto__" value="authored"></label>
    </body></html>`,
  })
  await api.dispose()

  await page.goto(`/d/${special.id}`)
  await expect(page.locator('#dossier-overlay')).toBeHidden()
  const field = page
    .frameLocator('#dossier-frame')
    .locator('[data-state="__proto__"]')
  await field.fill('saved safely')
  await page.locator('#dossier-save').click()
  await expect(page.locator('#dossier-status')).toHaveText(/^Saved · /)

  const stateApi = await apiRequest.newContext({ baseURL })
  const surface = await readSurface(stateApi, special.id)
  await stateApi.dispose()
  expect(Object.hasOwn(surface.fields, '__proto__')).toBe(true)
  expect(surface.fields.__proto__?.value).toBe('saved safely')

  await page.reload()
  await expect(page.locator('#dossier-overlay')).toBeHidden()
  await expect(field).toHaveValue('saved safely')
})

test('serializes Review latest with Save so an older GET cannot roll back a save', async ({
  page,
}) => {
  const review = await publishReview()
  await page.goto(`/d/${review.id}`)
  await expect(page.locator('#dossier-overlay')).toBeHidden()

  const api = await apiRequest.newContext({ baseURL })
  await save(api, review.id, { summary: 'Saved by someone else' })
  await api.dispose()

  const frame = page.frameLocator('#dossier-frame')
  await frame.locator('#summary').fill('My conflicting draft')
  await page.locator('#dossier-save').click()
  await expect(page.locator('#dossier-conflict')).toBeVisible()

  let releaseReview = () => {}
  const reviewGate = new Promise<void>((resolve) => {
    releaseReview = resolve
  })
  let reviewGets = 0
  let laterPosts = 0
  await page.route(`**/d/${review.id}/state`, async (route) => {
    if (route.request().method() === 'GET') {
      const response = await route.fetch()
      reviewGets += 1
      await reviewGate
      await route.fulfill({ response })
      return
    }
    laterPosts += 1
    await route.continue()
  })

  await page.locator('#dossier-conflict-review').click()
  await expect.poll(() => reviewGets).toBe(1)
  await frame.locator('#summary').fill('Ship the wrapper')
  await frame.locator('#notes').fill('Saved after reviewing')
  await page.locator('#dossier-save').click()
  expect(laterPosts).toBe(0)

  releaseReview()
  await expect(frame.locator('#summary')).toHaveValue('Saved by someone else')
  await expect(frame.locator('#notes')).toHaveValue('Saved after reviewing')
  await expect(page.locator('#dossier-status')).toHaveText('Unsaved changes')

  await page.locator('#dossier-save').click()
  await expect(page.locator('#dossier-status')).toHaveText(/^Saved · /)
  expect(laterPosts).toBe(1)
})

test('retries Review latest after its GET fails', async ({ page }) => {
  const review = await publishReview()
  await page.goto(`/d/${review.id}`)
  await expect(page.locator('#dossier-overlay')).toBeHidden()

  const api = await apiRequest.newContext({ baseURL })
  await save(api, review.id, {
    summary: 'Saved by someone else',
    notes: 'Latest saved notes',
  })
  await api.dispose()

  const frame = page.frameLocator('#dossier-frame')
  await frame.locator('#summary').fill('My conflicting draft')
  await page.locator('#dossier-save').click()
  await expect(page.locator('#dossier-conflict')).toBeVisible()

  await page.route(`**/d/${review.id}/state`, (route) =>
    route.request().method() === 'GET'
      ? route.abort('failed')
      : route.continue(),
  )
  await page.locator('#dossier-conflict-review').click()
  await expect(page.locator('#dossier-status')).toHaveText('Could not save')
  const retryLatest = page.locator('#dossier-save-retry')
  await expect(retryLatest).toBeVisible()
  await expect(page.locator('#dossier-conflict')).toBeHidden()

  await page.unroute(`**/d/${review.id}/state`)
  const loaded = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      response.url().endsWith(`/d/${review.id}/state`),
  )
  await retryLatest.click()
  await loaded
  await expect(frame.locator('#summary')).toHaveValue('My conflicting draft')
  await expect(frame.locator('#notes')).toHaveValue('Latest saved notes')
  await expect(page.locator('#dossier-status')).toHaveText('Unsaved changes')
  await expect(page.locator('#dossier-conflict')).toBeHidden()
})

test('saves a custom control that never announces its edits', async ({
  page,
}) => {
  const review = await publishReview()
  await page.goto(`/d/${review.id}`)
  await expect(page.locator('#dossier-overlay')).toBeHidden()

  const frame = page.frameLocator('#dossier-frame')
  const status = page.locator('#dossier-status')
  await frame.locator('#comment-input').fill('No onChange here')
  // Nothing was announced, so the bar still reads Save (A16).
  await expect(status).toHaveText('Save')

  await page.locator('#dossier-save').click()
  await expect(status).toHaveText(/^Saved · /)

  await page.reload()
  await expect(page.locator('#dossier-overlay')).toBeHidden()
  await expect(frame.locator('#comment-input')).toHaveValue('No onChange here')
  await expect(frame.locator('#comment-state')).toHaveText('No onChange here')

  // The registration beside it does hook onChange, and that one is immediate.
  await frame.locator('#reject-button').click()
  await expect(status).toHaveText('Unsaved changes')
})

test('saves from the keyboard and announces the status', async ({ page }) => {
  const review = await publishReview()
  await page.goto(`/d/${review.id}`)
  await expect(page.locator('#dossier-overlay')).toBeHidden()

  const status = page.locator('#dossier-status')
  await expect(status).toHaveAttribute('aria-live', 'polite')

  // Save is the first thing the Tab key reaches.
  await page.keyboard.press('Tab')
  const button = page.locator('#dossier-save')
  await expect(button).toBeFocused()
  expect(
    await page.evaluate(() =>
      document.getElementById('dossier-save')?.matches(':focus-visible'),
    ),
  ).toBe(true)

  await page.evaluate(() => {
    const statusLine = document.getElementById('dossier-status')!
    document.body.dataset.statusMutations = '0'
    new MutationObserver(() => {
      const count = Number(document.body.dataset.statusMutations ?? 0)
      document.body.dataset.statusMutations = String(count + 1)
    }).observe(statusLine, { childList: true })
  })
  await page.frameLocator('#dossier-frame').locator('#notes').focus()
  await page.keyboard.type(' and one more line', { delay: 20 })
  await expect(status).toHaveText('Unsaved changes')
  await expect(page.locator('body')).toHaveAttribute(
    'data-status-mutations',
    '1',
  )

  await button.focus()
  await page.keyboard.press('Enter')
  await expect(status).toHaveText(/^Saved · /)
  // Disabling the button mid-save would have thrown the focus away.
  await expect(button).toBeFocused()
})

test('names the current version and links to it when the HTML moved', async ({
  page,
}) => {
  const review = await publishReview()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route(`**/d/${review.id}/state`, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 409,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({
            ok: false,
            code: 'state_version_changed',
            message: 'The document version changed after this page loaded.',
            details: { currentVersion: 4 },
          }),
        })
      : route.continue(),
  )
  await page.goto(`/d/${review.id}`)
  await expect(page.locator('#dossier-overlay')).toBeHidden()

  const frame = page.frameLocator('#dossier-frame')
  await frame.locator('#summary').fill('Kept draft')
  await page.locator('#dossier-save').click()

  const status = page.locator('#dossier-status')
  await expect(status).toContainText('Unsaved changes')
  const link = status.locator('a')
  await expect(link).toHaveText('version 4 is current')
  await expect(link).toHaveAttribute('href', `/d/${review.id}`)
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', 'noopener')
  await expect(page.locator('#dossier-copy-draft')).toBeVisible()
  await expect(frame.locator('#summary')).toHaveValue('Kept draft')
  await expect(status).not.toContainText('Saved')
  await expectStatusFits(page)
})

test('keeps the loaded HTML version after Review latest sees a republish', async ({
  page,
}) => {
  const review = await publishReview()
  await page.goto(`/d/${review.id}`)
  await expect(page.locator('#dossier-overlay')).toBeHidden()

  const api = await apiRequest.newContext({ baseURL })
  await save(api, review.id, { notes: 'Saved by someone else' })

  const frame = page.frameLocator('#dossier-frame')
  await frame.locator('#notes').fill('Draft from the old HTML')
  await page.locator('#dossier-save').click()
  await expect(page.locator('#dossier-conflict')).toBeVisible()

  const current = await publish(api, {
    html: REVIEW_PAGE_RETYPE_HTML,
    documentId: review.id,
    acceptStateChanges: true,
  })
  await api.dispose()
  expect(current.version).toBeGreaterThan(review.version)

  await page.locator('#dossier-conflict-review').click()
  const status = page.locator('#dossier-status')
  await expect(status).toContainText(`version ${current.version} is current`)
  await expect(frame.locator('#summary')).toHaveCount(1)
  await expect(frame.locator('#summary')).toHaveAttribute('type', 'text')
  await expect(frame.locator('#notes')).toHaveValue('Draft from the old HTML')
  await expect(page.locator('#dossier-copy-draft')).toBeVisible()

  const request = page.waitForRequest(
    (candidate) =>
      candidate.method() === 'POST' &&
      candidate.url().endsWith(`/d/${review.id}/state`),
  )
  await page.locator('#dossier-save').click()
  const payload = (await request).postDataJSON() as { version: number }
  expect(payload.version).toBe(review.version)
  await expect(status).toContainText(`version ${current.version} is current`)
  await expect(frame.locator('#notes')).toHaveValue('Draft from the old HTML')
})

test('keeps the draft copyable when the authority is gone', async ({
  browser,
}) => {
  const review = await publishReview()
  const context = await browser.newContext({
    storageState: firstStorage,
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const page = await context.newPage()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route(`**/d/${review.id}/state`, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 410,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({
            ok: false,
            code: 'state_edit_required',
            message: 'State edit access is required.',
          }),
        })
      : route.continue(),
  )
  await page.goto(`${baseURL}/d/${review.id}`)
  await expect(page.locator('#dossier-overlay')).toBeHidden()

  const frame = page.frameLocator('#dossier-frame')
  await frame.locator('#summary').fill('Kept draft')
  await frame.locator('#comment-input').fill('and the silent one')
  await page.locator('#dossier-save').click()

  await expect(page.locator('#dossier-status')).toHaveText(
    'Could not save · saving is no longer allowed',
  )
  await expect(page.locator('#dossier-save')).toBeDisabled()
  await expect(frame.locator('#summary')).toHaveValue('Kept draft')
  await expectStatusFits(page)

  const copy = page.locator('#dossier-copy-draft')
  await expect(copy).toBeVisible()
  await copy.click()
  await expect(copy).toHaveText('Draft copied')
  const clipboard = await page.evaluate(() => navigator.clipboard.readText())
  expect(JSON.parse(clipboard)).toMatchObject({
    summary: 'Kept draft',
    comment: 'and the silent one',
  })

  await context.close()
})

for (const clipboardFailure of ['missing', 'rejected'] as const) {
  test(`offers manual draft copy when the Clipboard API is ${clipboardFailure}`, async ({
    browser,
  }) => {
    const review = await publishReview()
    const context = await browser.newContext({ storageState: firstStorage })
    await context.addInitScript((failure) => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value:
          failure === 'missing'
            ? undefined
            : {
                writeText: () =>
                  Promise.reject(new DOMException('Denied', 'NotAllowedError')),
              },
      })
    }, clipboardFailure)
    const page = await context.newPage()
    await page.route(`**/d/${review.id}/state`, (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 410,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify({
              ok: false,
              code: 'state_edit_required',
              message: 'State edit access is required.',
            }),
          })
        : route.continue(),
    )
    await page.goto(`${baseURL}/d/${review.id}`)
    await expect(page.locator('#dossier-overlay')).toBeHidden()

    const frame = page.frameLocator('#dossier-frame')
    await frame.locator('#summary').fill('Draft for manual copy')
    await frame.locator('#comment-input').fill('Silent draft too')
    await page.locator('#dossier-save').click()
    const copy = page.locator('#dossier-copy-draft')
    await copy.click()

    const fallback = page.locator('#dossier-copy-fallback')
    await expect(fallback).toBeVisible()
    await expect(copy).toHaveText('Copy manually')
    const text = page.locator('#dossier-copy-fallback-text')
    await expect(text).toBeFocused()
    const draft = JSON.parse(await text.inputValue()) as Record<string, unknown>
    expect(draft).toMatchObject({
      summary: 'Draft for manual copy',
      comment: 'Silent draft too',
    })
    expect(
      await text.evaluate((area) => {
        const textarea = area as HTMLTextAreaElement
        return (
          textarea.selectionStart === 0 &&
          textarea.selectionEnd === textarea.value.length
        )
      }),
    ).toBe(true)

    await page.locator('#dossier-copy-fallback-close').click()
    await expect(fallback).toBeHidden()
    await expect(copy).toBeFocused()
    await context.close()
  })
}

test('keeps the save bar inside 390 px in every failure state', async ({
  page,
}) => {
  const review = await publishReview()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/d/${review.id}`)
  await expect(page.locator('#dossier-overlay')).toBeHidden()

  const layout = () =>
    page.evaluate(() => {
      const line = document.getElementById('dossier-status')
      const button = document.getElementById('dossier-save')
      return {
        viewport: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth,
        fontSize: Number.parseFloat(getComputedStyle(line!).fontSize),
        statusWidth: line!.clientWidth,
        statusScrollWidth: line!.scrollWidth,
        saveHeight: button!.getBoundingClientRect().height,
        saveRight: button!.getBoundingClientRect().right,
      }
    })

  const status = page.locator('#dossier-status')
  const frame = page.frameLocator('#dossier-frame')
  await frame
    .locator('#summary')
    .fill('A summary long enough to push a narrow bar sideways if it could')
  await expect(status).toHaveText('Unsaved changes')
  let measured = await layout()
  expect(measured.content).toBeLessThanOrEqual(measured.viewport)
  expect(measured.fontSize).toBeGreaterThanOrEqual(12)
  // A touch target, and fully on screen.
  expect(measured.saveHeight).toBeGreaterThanOrEqual(40)
  expect(measured.saveRight).toBeLessThanOrEqual(measured.viewport)

  // Could not save, with Retry beside Save (A10, A15).
  await page.route(`**/d/${review.id}/state`, (route) =>
    route.request().method() === 'POST'
      ? route.abort('failed')
      : route.continue(),
  )
  await page.locator('#dossier-save').click()
  await expect(status).toHaveText('Could not save')
  await expect(page.locator('#dossier-save-retry')).toBeVisible()
  await expect(frame.locator('#summary')).toHaveValue(
    'A summary long enough to push a narrow bar sideways if it could',
  )
  measured = await layout()
  expect(measured.content).toBeLessThanOrEqual(measured.viewport)
  expect(measured.statusScrollWidth).toBeLessThanOrEqual(measured.statusWidth)
  expect(measured.saveRight).toBeLessThanOrEqual(measured.viewport)

  // Retry moves focus to Save before hiding itself, then uses the same path.
  await page.unroute(`**/d/${review.id}/state`)
  const saveRetry = page.locator('#dossier-save-retry')
  await saveRetry.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#dossier-save')).toBeFocused()
  await expect(status).toHaveText(/^Saved · /)
  await expect(saveRetry).toBeHidden()
  await expect(page.locator('#dossier-save')).toBeFocused()

  // The conflict dialog has to fit too.
  const dialog = page.locator('#dossier-conflict')
  await page.evaluate(() => {
    const list = document.getElementById('dossier-conflict-fields')
    list?.removeAttribute('hidden')
    const open = document.getElementById('dossier-conflict')
    ;(open as HTMLDialogElement).showModal()
  })
  await expect(dialog).toBeVisible()
  measured = await layout()
  expect(measured.content).toBeLessThanOrEqual(measured.viewport)
})
