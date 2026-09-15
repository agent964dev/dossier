import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  expect,
  request as apiRequest,
  test,
  type APIRequestContext,
  type Locator,
} from '@playwright/test'

const baseURL = process.env.DOSSIER_BROWSER_BASE_URL ?? 'http://localhost:8790'
const apiKey = process.env.DOSSIER_BROWSER_API_KEY ?? ''
const authDirectory = path.join(import.meta.dirname, '.auth')

/**
 * The account global setup seeded with a verified email, no membership, and no
 * invite. Everything it manages to do here it does through a grant.
 */
const grantStorage =
  process.env.DOSSIER_BROWSER_GRANT_STORAGE ??
  path.join(authDirectory, 'granted.json')
const grantEmail =
  process.env.DOSSIER_BROWSER_GRANT_EMAIL ?? 'granted@browser.test'

const REVIEW_PAGE_HTML = readFileSync(
  path.join(import.meta.dirname, 'fixtures', 'review-page.html'),
  'utf8',
)

interface StateGrant {
  readonly email: string
  readonly canSave: boolean
}

interface SharesBody {
  readonly configured: readonly string[]
  readonly effective: readonly string[]
  readonly grants: readonly StateGrant[]
}

/** A private stateful document of its own, so no two specs share a boundary. */
async function publishPrivate(api: APIRequestContext): Promise<string> {
  const response = await api.post('/api/uploads', {
    headers: { authorization: `Bearer ${apiKey}` },
    data: {
      html: REVIEW_PAGE_HTML,
      stateful: true,
      visibility: 'private',
      kind: 'plan',
    },
  })
  expect(response.status(), await response.text()).toBe(201)
  const body = (await response.json()) as {
    readonly document: { readonly id: string }
  }
  return body.document.id
}

/** The same share delta the CLI and the dashboard send. */
async function shareDelta(
  api: APIRequestContext,
  documentId: string,
  delta: Record<string, readonly string[]>,
): Promise<SharesBody> {
  const response = await api.post(`/api/documents/${documentId}/shares`, {
    headers: { authorization: `Bearer ${apiKey}` },
    data: delta,
  })
  expect(response.status(), await response.text()).toBe(200)
  return (await response.json()) as SharesBody
}

async function readShares(
  api: APIRequestContext,
  documentId: string,
): Promise<SharesBody> {
  const response = await api.get(`/api/documents/${documentId}/shares`, {
    headers: { authorization: `Bearer ${apiKey}` },
  })
  expect(response.status(), await response.text()).toBe(200)
  return (await response.json()) as SharesBody
}

/** What the owner sees, so a save made in the browser can be confirmed. */
async function readState(
  api: APIRequestContext,
  documentId: string,
): Promise<Readonly<Record<string, unknown>>> {
  const response = await api.get(`/api/documents/${documentId}/state`, {
    headers: { authorization: `Bearer ${apiKey}` },
  })
  expect(response.status(), await response.text()).toBe(200)
  return ((await response.json()) as { readonly data: Record<string, unknown> })
    .data
}

/**
 * The dashboard is a hydrated React page: its buttons stand in the server HTML
 * well before a handler is attached to them, and a click in that window is
 * simply lost. React tags each node it hydrates with the props it attached,
 * which is the one honest signal that the panel is live.
 */
async function hydrated(locator: Locator): Promise<void> {
  await expect
    .poll(
      () =>
        locator.evaluate((node) =>
          Object.keys(node).some((key) => key.startsWith('__reactProps$')),
        ),
      { message: 'the access panel never hydrated' },
    )
    .toBe(true)
}

test.beforeAll(() => {
  expect(apiKey, 'global setup must export DOSSIER_BROWSER_API_KEY').not.toBe(
    '',
  )
})

test('saves a private document through a grant, then keeps reading without it', async ({
  browser,
}) => {
  const api = await apiRequest.newContext({ baseURL })
  const documentId = await publishPrivate(api)
  await shareDelta(api, documentId, { addSavers: [grantEmail] })

  const context = await browser.newContext({ storageState: grantStorage })
  const page = await context.newPage()
  await page.goto(`${baseURL}/d/${documentId}`)
  await expect(page.locator('#dossier-overlay')).toBeHidden()

  // No membership and no invite: the grant alone opened a private document,
  // and the same grant is why Save is offered rather than "Read only" (A04).
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'account')
  await expect(page.locator('#dossier-status')).toHaveText('Save')
  await expect(page.locator('#dossier-save')).toBeEnabled()

  const frame = page.frameLocator('#dossier-frame')
  await frame.locator('#summary').fill('Reviewed through the grant')
  await frame.locator('[data-state="accessibility"]').check()
  await page.locator('#dossier-save').click()
  await expect(page.locator('#dossier-status')).toHaveText(/^Saved · /)

  // The owner reads back exactly what the granted person saved.
  expect(await readState(api, documentId)).toMatchObject({
    summary: 'Reviewed through the grant',
    accessibility: true,
  })

  // `share --remove --edit-state`: reading survives, saving stops.
  await shareDelta(api, documentId, { removeSavers: [grantEmail] })
  await page.reload()
  await expect(page.locator('#dossier-overlay')).toBeHidden()
  await expect(page.locator('#dossier-status')).toHaveText('Read only')
  await expect(page.locator('#dossier-save')).toBeDisabled()
  await expect(frame.locator('#summary')).toHaveValue(
    'Reviewed through the grant',
  )

  // A plain `share --remove` drops the row, and the document with it.
  await shareDelta(api, documentId, { removeGrants: [grantEmail] })
  const gone = await page.goto(`${baseURL}/d/${documentId}`)
  expect(gone?.status()).toBe(404)

  await context.close()
  await api.dispose()
})

test('toggles and removes a grant from the dashboard access panel', async ({
  page,
}) => {
  const api = await apiRequest.newContext({ baseURL })
  const documentId = await publishPrivate(api)
  await shareDelta(api, documentId, {
    add: [grantEmail],
    addSavers: [grantEmail],
  })

  await page.goto(`/dashboard/documents/${documentId}`)
  const toggle = page.getByRole('button', { name: `Can save: ${grantEmail}` })
  const inviteRow = page.locator('li', {
    has: page.getByRole('button', {
      name: `Remove ${grantEmail}`,
      exact: true,
    }),
  })
  const grantRow = page.locator('li', { has: toggle })

  // One email holding both powers carries both badges: the invite row says it
  // can save, the grant row says it is also invited.
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(inviteRow.getByText('can save', { exact: true })).toBeVisible()
  await expect(grantRow.getByText('invited', { exact: true })).toBeVisible()

  // The toggle is a button, so the keyboard alone drives the savers action.
  await hydrated(toggle)
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect((await readShares(api, documentId)).grants).toEqual([
    { email: grantEmail, canSave: false },
  ])
  await expect(inviteRow.getByText('can save', { exact: true })).toHaveCount(0)

  await page
    .getByRole('button', { name: `Remove the grant for ${grantEmail}` })
    .click()
  await expect(toggle).toHaveCount(0)

  // removeGrants drops the grant row and leaves the invite standing.
  const after = await readShares(api, documentId)
  expect(after.grants).toEqual([])
  expect(after.effective).toContain(grantEmail)

  await api.dispose()
})
