// The generated privacy text names each sign-in provider the Deployment
// turned on, and what Dossier keeps from it, and no provider it did not.
import { Effect } from 'effect'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { People, type Caller, type CurrentCaller } from '../src/core/index.ts'
import { defaultPrivacyText, PRIVACY_TEXT_LIMIT } from '../src/core/privacy.ts'
import { blocksOf } from '../src/lib/privacy-text.ts'
import { exec, rows } from './support/d1.ts'
import { harness, testRuntime } from './support/harness.ts'
import { runAs, sessionFor } from './support/people.ts'
import { person, superAdmin } from './support/trees.ts'

const DEPLOYMENT = 'dossier.test'
const PHOTO_COPY = /48\s*[×x]\s*48/

/** The paragraphs and list items of the text that name `provider`. */
const linesNaming = (text: string, provider: string) =>
  text.split('\n').filter((line) => line.includes(provider))

/** What Dossier keeps from a provider, said on one line that names it. */
const expectKeptFrom = (text: string, provider: string) => {
  const kept = linesNaming(text, provider).find(
    (line) =>
      /identifier/i.test(line) &&
      /\bname\b/i.test(line) &&
      /email/i.test(line) &&
      /(photo|picture)/i.test(line) &&
      /token/i.test(line),
  )
  expect(
    kept,
    `a line naming ${provider} with its identifier, name, email, photo and tokens`,
  ).toBeDefined()
  return kept ?? ''
}

const HEADINGS = [
  'What Dossier keeps',
  'Cookies',
  'No trackers',
  'Who sees what',
  'How long it is kept',
  'Where it is kept',
  'Questions',
]

const headingsOf = (text: string) => {
  const [, ...rest] = text.split('\n')
  return blocksOf(rest.join('\n'))
    .filter((block) => block.kind === 'heading')
    .map((block) => (block.kind === 'heading' ? block.text : ''))
}

describe('the privacy text for the providers turned on', () => {
  it('names Google alone when only Google is on, and keeps the address of its picture', () => {
    const text = defaultPrivacyText(DEPLOYMENT, ['google'])
    expect(text).toContain('Google')
    expect(text).not.toContain('Microsoft')
    expect(text).not.toMatch(PHOTO_COPY)
    expectKeptFrom(text, 'Google')
  })

  it('names Microsoft alone when only Microsoft is on, with its 48×48 photo copy', () => {
    const text = defaultPrivacyText(DEPLOYMENT, ['microsoft'])
    expect(text).toContain('Microsoft')
    expect(text).not.toContain('Google')
    const kept = expectKeptFrom(text, 'Microsoft')
    expect(kept).toMatch(PHOTO_COPY)
  })

  it('names both when both are on, the 48×48 copy for Microsoft only', () => {
    const text = defaultPrivacyText(DEPLOYMENT, ['google', 'microsoft'])
    expect(text).toContain('Google')
    expect(text).toContain('Microsoft')
    expectKeptFrom(text, 'Google')
    expect(expectKeptFrom(text, 'Microsoft')).toMatch(PHOTO_COPY)
    for (const line of linesNaming(text, 'Google')) {
      if (!line.includes('Microsoft')) expect(line).not.toMatch(PHOTO_COPY)
    }
    // Google is named before Microsoft.
    expect(text.indexOf('Google')).toBeLessThan(text.indexOf('Microsoft'))
  })

  it.each([
    { on: 'Google', providers: ['google'] },
    { on: 'Microsoft', providers: ['microsoft'] },
    { on: 'both', providers: ['google', 'microsoft'] },
  ] as const)(
    'keeps its sections and its limit with $on, and cites no design IDs',
    ({ providers }) => {
      const text = defaultPrivacyText(DEPLOYMENT, providers)
      expect(text.split('\n')[0]).toBe(`Privacy at ${DEPLOYMENT}`)
      expect(headingsOf(text)).toEqual(HEADINGS)
      expect(text.length).toBeLessThan(PRIVACY_TEXT_LIMIT)
      expect(text).not.toMatch(/\b[SBCXDT]-\d{2,3}\b|\bPRD\b|\bTDD\b/)
      expect(text).toMatch(/sign-in cookie[^.]*five minutes/)
    },
  )
})

describe("the generated text for the Deployment's own providers", () => {
  let chief: Caller

  beforeAll(async () => {
    await exec(`delete from deployment_settings where key = 'privacy_text'`)
    const boss = await person('chief')
    await superAdmin(boss)
    chief = await sessionFor(boss)
  })

  afterEach(async () => {
    harness.reset()
    await exec(`delete from deployment_settings where key = 'privacy_text'`)
  })

  const save = (text: string) =>
    runAs(
      chief,
      Effect.flatMap(People, (p) => p.setPrivacyText(text)) as Effect.Effect<
        void,
        unknown,
        CurrentCaller
      >,
    )

  const saved = () =>
    rows<{ value_json: string }>(
      `select value_json from deployment_settings where key = 'privacy_text'`,
    )

  it('reads the text for both providers as the generated one where both are on', async () => {
    await save(defaultPrivacyText(DEPLOYMENT, ['google', 'microsoft']))
    expect(await saved()).toEqual([])
    await save(defaultPrivacyText(DEPLOYMENT, ['google']))
    expect(await saved()).toHaveLength(1)
  })

  it('reads the text for Microsoft alone as the generated one where only Microsoft is on', async () => {
    harness.use(
      testRuntime({ env: { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' } }),
    )
    await save(defaultPrivacyText(DEPLOYMENT, ['microsoft']))
    expect(await saved()).toEqual([])
    await save(defaultPrivacyText(DEPLOYMENT, ['google', 'microsoft']))
    expect(await saved()).toHaveLength(1)
  })
})
