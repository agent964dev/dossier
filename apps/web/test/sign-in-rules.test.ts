// The sign-in rules as tables: what Google says about an email, who may join
// a person, when a known account's email follows the provider, which tokens
// pass the checks, and the one log line a refused sign-in leaves.
import type { PersonId } from '@dossier/contracts'
import { describe, expect, it } from 'vitest'

import {
  authorityOf,
  checkToken,
  decideEmailChange,
  decideLink,
  googleTrust,
  signInDiagnostic,
} from '../src/core/sign-in-rules.ts'

const CLIENT = 'test-client.apps.googleusercontent.com'
const NOW = 1_800_000_000

/** A Google ID token's claims as Google sends them for a Gmail account. */
const google = (over: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT,
  azp: CLIENT,
  sub: '110169484474386276334',
  email: 'sara@gmail.com',
  email_verified: true,
  name: 'Sara Haddad',
  picture: 'https://lh3.googleusercontent.com/a/sara',
  iat: NOW - 10,
  exp: NOW + 3590,
  ...over,
})

const without = (claims: Record<string, unknown>, name: string) =>
  Object.fromEntries(Object.entries(claims).filter(([key]) => key !== name))

describe('what Google says about the email it sent', () => {
  it.each([
    {
      account: 'a verified Gmail account',
      profile: google(),
      trust: { confirmed: true, authority: true },
    },
    {
      account: 'a verified Googlemail account',
      profile: google({ email: 'sara@googlemail.com' }),
      trust: { confirmed: true, authority: true },
    },
    {
      account: 'a Workspace account, which carries its hosted domain',
      profile: google({ email: 'sara@acme.test', hd: 'acme.test' }),
      trust: { confirmed: true, authority: true },
    },
    {
      account: 'a personal Google account on a custom domain, without hd',
      profile: google({ email: 'sara@acme.test' }),
      trust: { confirmed: true, authority: false },
    },
    {
      account: 'an account whose hosted domain is empty',
      profile: google({ email: 'sara@acme.test', hd: '' }),
      trust: { confirmed: true, authority: false },
    },
    {
      account: 'a domain that only looks like Gmail',
      profile: google({ email: 'sara@notgmail.com' }),
      trust: { confirmed: true, authority: false },
    },
    {
      account: 'Gmail inside another domain',
      profile: google({ email: 'sara@gmail.com.evil.test' }),
      trust: { confirmed: true, authority: false },
    },
    {
      account: 'a Gmail account with email_verified false',
      profile: google({ email_verified: false }),
      trust: { confirmed: false, authority: false },
    },
    {
      account: 'a Workspace account with email_verified false',
      profile: google({
        email: 'sara@acme.test',
        hd: 'acme.test',
        email_verified: false,
      }),
      trust: { confirmed: false, authority: false },
    },
    {
      account: 'an account with no email_verified claim',
      profile: without(google(), 'email_verified'),
      trust: { confirmed: false, authority: false },
    },
  ])('$account', ({ profile, trust }) => {
    expect(googleTrust(profile)).toEqual(trust)
  })
})

describe('the authority stored for a sign-in', () => {
  it.each([
    { provider: 'google', authority: true, stored: 'google' },
    { provider: 'google', authority: false, stored: 'none' },
    { provider: 'microsoft', authority: true, stored: 'microsoft' },
    { provider: 'microsoft', authority: false, stored: 'none' },
  ] as const)(
    '$provider with authority $authority is stored as $stored',
    ({ provider, authority, stored }) => {
      expect(authorityOf({ provider, authority })).toBe(stored)
    },
  )
})

describe('joining the person who holds the email', () => {
  const existing = [
    { accountId: 'by-google', authority: 'google' },
    { accountId: 'lapsed', authority: 'none' },
    { accountId: 'by-microsoft', authority: 'microsoft' },
  ] as const

  it('refuses an account whose provider is not the authority', () => {
    expect(decideLink('none', existing)).toEqual({ kind: 'refuse' })
    expect(decideLink('none', [])).toEqual({ kind: 'refuse' })
  })

  it.each(['google', 'microsoft'] as const)(
    'lets a %s account with authority join and take over only the accounts no provider vouches for',
    (incoming) => {
      expect(decideLink(incoming, existing)).toEqual({
        kind: 'link',
        takeover: ['lapsed'],
      })
    },
  )

  it('takes over nothing when every account has an authority', () => {
    expect(
      decideLink('google', [
        { accountId: 'by-google', authority: 'google' },
        { accountId: 'by-microsoft', authority: 'microsoft' },
      ]),
    ).toEqual({ kind: 'link', takeover: [] })
    expect(decideLink('microsoft', [])).toEqual({ kind: 'link', takeover: [] })
  })
})

describe("a known account's new email", () => {
  const self = 'person-self' as PersonId
  const other = 'person-other' as PersonId

  it.each([
    {
      when: 'is not confirmed and nobody holds it',
      confirmed: false,
      holder: null,
      decision: 'keep-unconfirmed',
    },
    {
      when: 'is not confirmed and another person holds it (the confirmation check comes first)',
      confirmed: false,
      holder: other,
      decision: 'keep-unconfirmed',
    },
    {
      when: 'is confirmed and another person holds it',
      confirmed: true,
      holder: other,
      decision: 'keep-in-use',
    },
    {
      when: 'is confirmed and nobody holds it',
      confirmed: true,
      holder: null,
      decision: 'update',
    },
    {
      when: 'is confirmed and the person already holds it',
      confirmed: true,
      holder: self,
      decision: 'update',
    },
  ] as const)('$when: $decision', ({ confirmed, holder, decision }) => {
    expect(decideEmailChange({ confirmed, holder, self })).toBe(decision)
  })
})

describe("checking a Google ID token's claims", () => {
  it.each([
    { token: 'a token Google issued for this client', claims: google() },
    {
      token: 'the issuer without its scheme',
      claims: google({ iss: 'accounts.google.com' }),
    },
    {
      token: 'an audience list that contains the client',
      claims: google({ aud: ['another-client', CLIENT] }),
    },
    {
      token: 'a token that expired 29 seconds ago',
      claims: google({ exp: NOW - 29 }),
    },
  ])('passes $token', ({ claims }) => {
    expect(checkToken('google', claims, CLIENT, NOW)).toBeNull()
  })

  it.each([
    {
      token: 'another issuer',
      claims: google({ iss: 'https://evil.example' }),
      check: 'issuer',
    },
    {
      token: 'the issuer over http',
      claims: google({ iss: 'http://accounts.google.com' }),
      check: 'issuer',
    },
    {
      token: "Microsoft's issuer",
      claims: google({
        iss: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0',
      }),
      check: 'issuer',
    },
    {
      token: 'no issuer',
      claims: without(google(), 'iss'),
      check: 'issuer',
    },
    {
      token: 'no audience',
      claims: without(google(), 'aud'),
      check: 'audience',
    },
    {
      token: 'another client',
      claims: google({ aud: 'another-client.apps.googleusercontent.com' }),
      check: 'audience',
    },
    {
      token: 'an audience list without the client',
      claims: google({ aud: ['another-client'] }),
      check: 'audience',
    },
    {
      token: 'a token that expired 31 seconds ago',
      claims: google({ exp: NOW - 31 }),
      check: 'expired',
    },
    {
      token: 'a token that expired an hour ago',
      claims: google({ exp: NOW - 3600 }),
      check: 'expired',
    },
    {
      token: 'no expiry',
      claims: without(google(), 'exp'),
      check: 'expired',
    },
  ] as const)('refuses $token with $check', ({ claims, check }) => {
    expect(checkToken('google', claims, CLIENT, NOW)).toBe(check)
  })
})

describe('the log line of a refused Google sign-in', () => {
  const KEYS = [
    'account',
    'carried',
    'check',
    'error',
    'message',
    'provider',
    'reason',
    'xms_edov',
  ]

  it('names the provider and the failed check, and nothing that names the person', () => {
    const profile = google({ aud: 'another-client' })
    const line = signInDiagnostic('google', profile, 'token_check', {
      check: 'audience',
    })
    expect(Object.keys(line).sort()).toEqual(KEYS)
    expect(line).toEqual({
      message: 'sign-in refused',
      provider: 'google',
      reason: 'token_check',
      error: null,
      check: 'audience',
      account: null,
      carried: null,
      xms_edov: null,
    })
    const text = JSON.stringify(line)
    expect(text).not.toContain('sara@gmail.com')
    expect(text).not.toContain('Sara Haddad')
  })

  it.each(['issuer', 'audience', 'expired'] as const)(
    'carries the %s check',
    (check) => {
      expect(
        signInDiagnostic('google', google(), 'token_check', { check }),
      ).toMatchObject({ reason: 'token_check', check, error: null })
    },
  )

  it.each(['not_confirmed', 'no_email'] as const)(
    'has no check and no error for %s',
    (reason) => {
      const line = signInDiagnostic('google', google(), reason, {})
      expect(Object.keys(line).sort()).toEqual(KEYS)
      expect(line).toEqual({
        message: 'sign-in refused',
        provider: 'google',
        reason,
        error: null,
        check: null,
        account: null,
        carried: null,
        xms_edov: null,
      })
      expect(JSON.stringify(line)).not.toContain('sara@gmail.com')
    },
  )

  it.each([
    { error: 'access_denied', kept: 'access_denied' },
    { error: 'invalid_code', kept: 'invalid_code' },
    { error: 'a'.repeat(64), kept: 'a'.repeat(64) },
    { error: 'a'.repeat(65), kept: null },
    { error: '', kept: null },
    { error: 'Access_Denied', kept: null },
    { error: 'access denied', kept: null },
    { error: 'access-denied', kept: null },
    { error: 'unable_to_get_user_info2', kept: null },
    { error: 'sara@gmail.com', kept: null },
    { error: 'The user declined the consent screen.', kept: null },
  ])(
    'keeps the provider error $error only as a short code',
    ({ error, kept }) => {
      const line = signInDiagnostic('google', null, 'provider_error', {
        error,
      })
      expect(Object.keys(line).sort()).toEqual(KEYS)
      expect(line).toEqual({
        message: 'sign-in refused',
        provider: 'google',
        reason: 'provider_error',
        error: kept,
        check: null,
        account: null,
        carried: null,
        xms_edov: null,
      })
    },
  )
})
