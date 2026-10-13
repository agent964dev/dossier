import type { Person } from '@dossier/contracts'
import { Effect } from 'effect'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  defaultPrivacyText,
  People,
  PRIVACY_TEXT_LIMIT,
  Settings,
  type Caller,
  type CurrentCaller,
} from '../src/core/index.ts'
import { settingsOf } from '../src/core/settings.ts'
import { exec, rows } from './support/d1.ts'
import { runAs, sessionFor } from './support/people.ts'
import {
  failureAs,
  join,
  person,
  superAdmin,
  workspace,
} from './support/trees.ts'

const DEPLOYMENT = 'dossier.test'

let chief: Caller
let wsAdmin: Caller
let member: Caller

beforeAll(async () => {
  await exec(`delete from deployment_settings where key = 'privacy_text'`)
  const boss: Person = await person('chief')
  await superAdmin(boss)
  chief = await sessionFor(boss)
  const owner = await person('owner')
  const ws = await workspace(owner)
  wsAdmin = await sessionFor(owner)
  const plain = await person('member')
  await join(ws, plain)
  member = await sessionFor(plain)
})

const privacyOf = async (caller: Caller) =>
  (
    await runAs(
      caller,
      Effect.flatMap(Settings, (s) => s.current()),
    )
  ).privacyText

const save = (caller: Caller, text: string | null) =>
  runAs(
    caller,
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

describe('the generated privacy text', () => {
  const text = defaultPrivacyText(DEPLOYMENT)

  it('names the deployment and what Dossier keeps', () => {
    expect(text.split('\n')[0]).toBe(`Privacy at ${DEPLOYMENT}`)
    for (const kept of [
      "Google account's identifier",
      'your name, your email address',
      'Sessions:',
      'IP address',
      'Agent keys:',
      'the files you or your agents push',
      'the answers you send through forms',
      'the comments you write',
      'Seen by:',
      'counts its views, without names',
      'random cookie',
    ]) {
      expect(text, kept).toContain(kept)
    }
  })

  it('says Dossier’s own screens load nothing from third parties', () => {
    expect(text).toContain(
      "Dossier's own screens load nothing from other sites: no analytics, no advertising and no tracking.",
    )
    expect(text).toContain('none for advertising or analytics')
  })

  it('names every cookie Dossier sets, the short-lived sign-in cookie included', () => {
    expect(text).toContain('session cookie')
    expect(text).toContain('visitor cookie')
    expect(text).toMatch(/sign-in cookie[^.]*five minutes/)
    expect(text).not.toContain('It sets no other cookies')
  })

  it('cites no design IDs and keeps within the saved text’s limit', () => {
    expect(text).not.toMatch(/\b[SBCXDT]-\d{2,3}\b|\bPRD\b|\bTDD\b/)
    expect(text.length).toBeLessThan(PRIVACY_TEXT_LIMIT)
  })
})

describe('a super admin’s privacy text', () => {
  it('starts as none, so the generated text shows', async () => {
    expect(await privacyOf(member)).toBeNull()
  })

  it('is saved by a super admin and read by everyone', async () => {
    await save(chief, '  Our privacy\r\n\r\nWe keep what you send.  \n')
    expect(await privacyOf(member)).toBe(
      'Our privacy\n\nWe keep what you send.',
    )
    expect(await privacyOf(chief)).toBe('Our privacy\n\nWe keep what you send.')
  })

  it('answers not_found to a workspace admin and a member, and changes nothing', async () => {
    for (const caller of [wsAdmin, member]) {
      const error = await failureAs(
        caller,
        Effect.flatMap(People, (p) => p.setPrivacyText('Mine now')),
      )
      expect(error).toMatchObject({ code: 'not_found' })
    }
    expect(await privacyOf(member)).toBe(
      'Our privacy\n\nWe keep what you send.',
    )
  })

  it('refuses text over 20,000 characters, naming the limit', async () => {
    const error = await failureAs(
      chief,
      Effect.flatMap(People, (p) =>
        p.setPrivacyText('x'.repeat(PRIVACY_TEXT_LIMIT + 1)),
      ),
    )
    expect(error).toMatchObject({ code: 'invalid', path: 'text' })
    expect((error as { message: string }).message).toContain('20,000')
    await save(chief, 'y'.repeat(PRIVACY_TEXT_LIMIT))
    expect(await privacyOf(member)).toHaveLength(PRIVACY_TEXT_LIMIT)
  })

  it('returns to the generated text on Reset, on empty text, and when given the generated text', async () => {
    await save(chief, null)
    expect(await saved()).toEqual([])
    expect(await privacyOf(member)).toBeNull()

    await save(chief, 'Edited')
    await save(chief, '   \n ')
    expect(await saved()).toEqual([])

    await save(chief, 'Edited')
    await save(chief, `${defaultPrivacyText(DEPLOYMENT)}\n\n`)
    expect(await saved()).toEqual([])
    expect(await privacyOf(member)).toBeNull()
  })

  it('reads a malformed or oversized saved value as none', () => {
    const at = (value: unknown) =>
      settingsOf([{ key: 'privacy_text', valueJson: JSON.stringify(value) }])
        .privacyText
    expect(at(42)).toBeNull()
    expect(at('   ')).toBeNull()
    expect(at('z'.repeat(PRIVACY_TEXT_LIMIT + 1))).toBeNull()
    expect(at('Ours')).toBe('Ours')
  })

  it('is a key the settings table accepts, and no other new key is', async () => {
    await expect(
      exec(
        `insert into deployment_settings (key, value_json, updated_at) values ('privacy', '"x"', 0)`,
      ),
    ).rejects.toThrow(/CHECK/)
  })
})
