// Microsoft's sign-in rules as tables: which kind of account a token is, when
// Microsoft confirms an email and is its authority, which tokens pass the
// checks, and what the one log line of a refused Microsoft sign-in holds.
import { describe, expect, it } from 'vitest'

import {
  checkToken,
  MICROSOFT_CONSUMER_DOMAINS,
  microsoftAccountKind,
  microsoftTrust,
  PERSONAL_MICROSOFT_TENANT,
  signInDiagnostic,
} from '../src/core/sign-in-rules.ts'

const CLIENT = '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f'
const NOW = 1_800_000_000
const PERSONAL = '9188040d-6c67-4c5b-b112-36a304b66dad'
const CONTOSO = '72f988bf-86f1-41af-91ab-2d7cd011db47'
const FABRIKAM = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

/** Microsoft's issuer for a tenant. */
const issuerOf = (tid: string) =>
  `https://login.microsoftonline.com/${tid}/v2.0`

/** Claims without the ones set to undefined, as a token leaves them out. */
const clean = (claims: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(claims).filter(([, value]) => value !== undefined),
  )

/** A native work account's ID token, as Microsoft's v2.0 endpoint sends it. */
const work = (over: Record<string, unknown> = {}) =>
  clean({
    ver: '2.0',
    iss: issuerOf(CONTOSO),
    aud: CLIENT,
    iat: NOW - 10,
    nbf: NOW - 10,
    exp: NOW + 3590,
    tid: CONTOSO,
    oid: '00000000-0000-0000-66f3-3332eca7ea81',
    sub: 'AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ',
    name: 'Ana Silva',
    preferred_username: 'ana@contoso.test',
    email: 'ana@contoso.test',
    xms_edov: true,
    ...over,
  })

/** A personal Microsoft account's ID token. */
const personal = (over: Record<string, unknown> = {}) =>
  work({
    iss: issuerOf(PERSONAL),
    tid: PERSONAL,
    preferred_username: 'ana@outlook.com',
    email: 'ana@outlook.com',
    xms_edov: undefined,
    ...over,
  })

/** A guest in Contoso's directory, signed in through `idp`. */
const guest = (idp: string, over: Record<string, unknown> = {}) =>
  work({ idp, email: 'ana@outlook.com', xms_edov: true, ...over })

/** The list the outline settles on, exactly. */
const CONSUMER_DOMAINS = [
  'hotmail.be',
  'hotmail.ca',
  'hotmail.co.jp',
  'hotmail.co.uk',
  'hotmail.com',
  'hotmail.com.br',
  'hotmail.de',
  'hotmail.es',
  'hotmail.fr',
  'hotmail.hu',
  'hotmail.it',
  'hotmail.nl',
  'live.be',
  'live.ca',
  'live.cn',
  'live.co.uk',
  'live.com',
  'live.com.au',
  'live.de',
  'live.fr',
  'live.it',
  'live.jp',
  'live.nl',
  'msn.com',
  'outlook.at',
  'outlook.be',
  'outlook.cl',
  'outlook.co.id',
  'outlook.co.il',
  'outlook.co.nz',
  'outlook.co.th',
  'outlook.com',
  'outlook.com.ar',
  'outlook.com.au',
  'outlook.com.br',
  'outlook.com.gr',
  'outlook.com.pe',
  'outlook.com.tr',
  'outlook.com.vn',
  'outlook.cz',
  'outlook.de',
  'outlook.dk',
  'outlook.es',
  'outlook.fr',
  'outlook.hu',
  'outlook.ie',
  'outlook.in',
  'outlook.it',
  'outlook.jp',
  'outlook.kr',
  'outlook.lv',
  'outlook.my',
  'outlook.ph',
  'outlook.pt',
  'outlook.sa',
  'outlook.sg',
  'outlook.sk',
  'windowslive.com',
]

const YES = { confirmed: true, authority: true }
const NO = { confirmed: false, authority: false }

describe("Microsoft's own consumer domains", () => {
  it('names the personal-account tenant', () => {
    expect(PERSONAL_MICROSOFT_TENANT).toBe(PERSONAL)
  })

  it('holds exactly the 58 settled domains, lower-cased', () => {
    expect(CONSUMER_DOMAINS).toHaveLength(58)
    expect(MICROSOFT_CONSUMER_DOMAINS.size).toBe(58)
    expect([...MICROSOFT_CONSUMER_DOMAINS].sort()).toEqual(
      [...CONSUMER_DOMAINS].sort(),
    )
    for (const domain of MICROSOFT_CONSUMER_DOMAINS) {
      expect(domain).toBe(domain.trim().toLowerCase())
    }
  })

  it.each([
    'outlook.co.uk',
    'passport.com',
    'live.com.mx',
    'hotmail.com.au',
    'sub.outlook.com',
    'live.example.com',
  ])('leaves out %s', (domain) => {
    expect(MICROSOFT_CONSUMER_DOMAINS.has(domain)).toBe(false)
  })
})

describe('the kind of Microsoft account a token is', () => {
  it.each([
    { account: 'a personal account', profile: personal(), kind: 'personal' },
    {
      account: 'a native work account, without idp',
      profile: work(),
      kind: 'work',
    },
    {
      account: 'a native work account whose idp is its own issuer',
      profile: work({ idp: issuerOf(CONTOSO) }),
      kind: 'work',
    },
    {
      account: 'a guest from a personal account, idp live.com',
      profile: guest('live.com'),
      kind: 'personal_guest',
    },
    {
      account:
        "a guest from a personal account, idp the personal tenant's v1 issuer",
      profile: guest(`https://sts.windows.net/${PERSONAL}/`),
      kind: 'personal_guest',
    },
    {
      account:
        "a guest from a personal account, idp the personal tenant's v2 issuer",
      profile: guest(issuerOf(PERSONAL)),
      kind: 'personal_guest',
    },
    {
      account: 'a guest from another directory, by its v1 issuer',
      profile: guest(`https://sts.windows.net/${FABRIKAM}/`),
      kind: 'guest',
    },
    {
      account: 'a guest from another directory, by its v2 issuer',
      profile: guest(issuerOf(FABRIKAM)),
      kind: 'guest',
    },
    {
      account: 'a guest from Google',
      profile: guest('google.com'),
      kind: 'guest',
    },
    {
      account: 'a guest by one-time passcode',
      profile: guest('mail'),
      kind: 'guest',
    },
    {
      account: 'a guest whose idp only looks like live.com',
      profile: guest('live.com.evil.test'),
      kind: 'guest',
    },
  ])('$account is $kind', ({ profile, kind }) => {
    expect(microsoftAccountKind(profile)).toBe(kind)
  })
})

describe('what Microsoft says about the email it sent', () => {
  it.each([
    {
      account: 'an Outlook.com personal account',
      profile: personal(),
      trust: YES,
    },
    {
      account: 'a personal account on a country form, hotmail.co.uk',
      profile: personal({ email: 'ana@hotmail.co.uk' }),
      trust: YES,
    },
    {
      account: 'a personal account whose email is in capitals',
      profile: personal({ email: 'Ana@Outlook.COM' }),
      trust: YES,
    },
    {
      account: 'a personal account on Gmail',
      profile: personal({ email: 'ana@gmail.com' }),
      trust: NO,
    },
    {
      account: 'a personal account on a look-alike domain, live.example.com',
      profile: personal({ email: 'ana@live.example.com' }),
      trust: NO,
    },
    {
      account: 'a personal account on a subdomain, sub.outlook.com',
      profile: personal({ email: 'ana@sub.outlook.com' }),
      trust: NO,
    },
    {
      account: 'a personal account on outlook.co.uk, which is left out',
      profile: personal({ email: 'ana@outlook.co.uk' }),
      trust: NO,
    },
    {
      account: 'a personal account on outlook.com inside another domain',
      profile: personal({ email: 'ana@outlook.com.evil.test' }),
      trust: NO,
    },
    {
      account: 'a personal account on a company domain',
      profile: personal({ email: 'ana@contoso.test' }),
      trust: NO,
    },
    {
      account: 'a personal account without an email',
      profile: personal({ email: undefined }),
      trust: NO,
    },
    {
      account: 'a personal Outlook.com account whose email_verified is false',
      profile: personal({ email_verified: false }),
      trust: YES,
    },
    {
      account: 'a work account with xms_edov true',
      profile: work(),
      trust: YES,
    },
    {
      account: 'a work account with xms_edov false',
      profile: work({ xms_edov: false }),
      trust: NO,
    },
    {
      account: 'a work account without xms_edov',
      profile: work({ xms_edov: undefined }),
      trust: NO,
    },
    {
      account: 'a work account whose xms_edov is the text "true"',
      profile: work({ xms_edov: 'true' }),
      trust: NO,
    },
    {
      account: 'a work account with xms_edov true and no email',
      profile: work({ email: undefined }),
      trust: NO,
    },
    {
      account: 'a work account with email_verified true and no xms_edov',
      profile: work({ xms_edov: undefined, email_verified: true }),
      trust: NO,
    },
    {
      account:
        'a work account whose email is listed as a verified primary and secondary email',
      profile: work({
        xms_edov: undefined,
        verified_primary_email: ['ana@contoso.test'],
        verified_secondary_email: ['ana@contoso.test'],
      }),
      trust: NO,
    },
    {
      account: 'a work account on outlook.com without xms_edov',
      profile: work({ email: 'ana@outlook.com', xms_edov: undefined }),
      trust: NO,
    },
    {
      account: 'a native work account whose idp is its own issuer',
      profile: work({ idp: issuerOf(CONTOSO) }),
      trust: YES,
    },
    {
      account:
        'a guest from a personal account on outlook.com, whose email the inviting directory sets',
      profile: guest('live.com'),
      trust: NO,
    },
    {
      account:
        'a guest from a personal account on outlook.com, by the v2 issuer',
      profile: guest(issuerOf(PERSONAL)),
      trust: NO,
    },
    {
      account: 'a guest from a personal account on an outside address',
      profile: guest('live.com', { email: 'ana@gmail.com' }),
      trust: NO,
    },
    {
      account: 'a guest from another directory, with xms_edov true',
      profile: guest(`https://sts.windows.net/${FABRIKAM}/`, {
        email: 'ana@fabrikam.test',
      }),
      trust: NO,
    },
    {
      account: 'a guest from another directory on outlook.com',
      profile: guest(issuerOf(FABRIKAM)),
      trust: NO,
    },
    {
      account: 'a guest from Google with xms_edov true',
      profile: guest('google.com', { email: 'ana@gmail.com' }),
      trust: NO,
    },
  ])('$account', ({ profile, trust }) => {
    expect(microsoftTrust(profile)).toEqual(trust)
  })

  it.each(CONSUMER_DOMAINS)('confirms a personal account on %s', (domain) => {
    expect(microsoftTrust(personal({ email: `ana@${domain}` }))).toEqual(YES)
  })
})

describe('the checks on a Microsoft ID token', () => {
  it.each([
    { token: 'a work token', claims: work() },
    { token: 'a personal token', claims: personal() },
    {
      token: 'a guest token',
      claims: guest(`https://sts.windows.net/${FABRIKAM}/`),
    },
    {
      token: 'an audience list holding the client',
      claims: work({ aud: ['another-client', CLIENT] }),
    },
    {
      token: 'a token that expired 29 seconds ago',
      claims: work({ exp: NOW - 29 }),
    },
  ])('passes $token', ({ claims }) => {
    expect(checkToken('microsoft', claims, CLIENT, NOW)).toBeNull()
  })

  it.each([
    {
      token: 'a tenant that is not a GUID, with an issuer that names it',
      claims: work({ tid: 'contoso', iss: issuerOf('contoso') }),
      check: 'issuer',
    },
    {
      token: 'a tenant GUID that is too short',
      claims: work({
        tid: '72f988bf-86f1-41af-91ab-2d7cd011db4',
        iss: issuerOf('72f988bf-86f1-41af-91ab-2d7cd011db4'),
      }),
      check: 'issuer',
    },
    {
      token: 'a tenant that is not hex',
      claims: work({
        tid: 'zzzzzzzz-86f1-41af-91ab-2d7cd011db47',
        iss: issuerOf('zzzzzzzz-86f1-41af-91ab-2d7cd011db47'),
      }),
      check: 'issuer',
    },
    {
      token: "the common endpoint's issuer template",
      claims: work({ tid: '{tenantid}', iss: issuerOf('{tenantid}') }),
      check: 'issuer',
    },
    {
      token: 'no tenant',
      claims: work({ tid: undefined }),
      check: 'issuer',
    },
    {
      token: "another tenant's issuer",
      claims: work({ iss: issuerOf(FABRIKAM) }),
      check: 'issuer',
    },
    {
      token: "the personal tenant's issuer on a work token",
      claims: work({ iss: issuerOf(PERSONAL) }),
      check: 'issuer',
    },
    {
      token: "the tenant's v1 issuer",
      claims: work({ iss: `https://sts.windows.net/${CONTOSO}/` }),
      check: 'issuer',
    },
    {
      token: "Google's issuer",
      claims: work({ iss: 'https://accounts.google.com' }),
      check: 'issuer',
    },
    {
      token: 'another client',
      claims: work({ aud: 'another-client' }),
      check: 'audience',
    },
    {
      token: 'no audience',
      claims: work({ aud: undefined }),
      check: 'audience',
    },
    {
      token: 'an audience list without the client',
      claims: work({ aud: ['another-client'] }),
      check: 'audience',
    },
    {
      token: 'a token that expired 31 seconds ago',
      claims: work({ exp: NOW - 31 }),
      check: 'expired',
    },
    {
      token: 'no expiry',
      claims: work({ exp: undefined }),
      check: 'expired',
    },
  ] as const)('refuses $token with $check', ({ claims, check }) => {
    expect(checkToken('microsoft', claims, CLIENT, NOW)).toBe(check)
  })
})

describe('the log line of a refused Microsoft sign-in', () => {
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

  /** Nothing in the line names the person or carries an identifier. */
  const namesNoOne = (line: unknown, profile: Record<string, unknown>) => {
    const text = JSON.stringify(line)
    for (const claim of ['email', 'name', 'preferred_username', 'oid', 'sub']) {
      const value = profile[claim]
      if (typeof value === 'string') expect(text).not.toContain(value)
    }
    expect(text).not.toContain('ana@')
    expect(text).not.toContain('Ana Silva')
  }

  it.each([
    {
      token: 'a work account with xms_edov false',
      profile: work({ xms_edov: false }),
      reason: 'not_confirmed',
      account: 'work',
      carried: { email: true, xms_edov: true, idp: false },
      xms_edov: false,
    },
    {
      token: 'a work account without xms_edov',
      profile: work({ xms_edov: undefined }),
      reason: 'not_confirmed',
      account: 'work',
      carried: { email: true, xms_edov: false, idp: false },
      xms_edov: null,
    },
    {
      token: 'a work account whose xms_edov is not a boolean',
      profile: work({ xms_edov: 'true' }),
      reason: 'not_confirmed',
      account: 'work',
      carried: { email: true, xms_edov: true, idp: false },
      xms_edov: null,
    },
    {
      token: 'a personal account on Gmail',
      profile: personal({ email: 'ana@gmail.com' }),
      reason: 'not_confirmed',
      account: 'personal',
      carried: { email: true, xms_edov: false, idp: false },
      xms_edov: null,
    },
    {
      token: 'a work account with no email',
      profile: work({ email: undefined }),
      reason: 'no_email',
      account: 'work',
      carried: { email: false, xms_edov: true, idp: false },
      xms_edov: true,
    },
    {
      token: 'a personal account with no email',
      profile: personal({ email: undefined }),
      reason: 'no_email',
      account: 'personal',
      carried: { email: false, xms_edov: false, idp: false },
      xms_edov: null,
    },
    {
      token: 'a guest from a personal account on an outside address',
      profile: guest('live.com', { email: 'ana@gmail.com' }),
      reason: 'not_confirmed',
      account: 'personal_guest',
      carried: { email: true, xms_edov: true, idp: true },
      xms_edov: true,
    },
    {
      token: 'a guest from another directory',
      profile: guest(`https://sts.windows.net/${FABRIKAM}/`, {
        email: 'ana@fabrikam.test',
      }),
      reason: 'guest',
      account: 'guest',
      carried: { email: true, xms_edov: true, idp: true },
      xms_edov: true,
    },
  ] as const)(
    '$token: $reason, $account, and which claims it carried',
    ({ profile, reason, account, carried, xms_edov }) => {
      const line = signInDiagnostic('microsoft', profile, reason, {})
      expect(Object.keys(line).sort()).toEqual(KEYS)
      expect(line).toEqual({
        message: 'sign-in refused',
        provider: 'microsoft',
        reason,
        error: null,
        check: null,
        account,
        carried,
        xms_edov,
      })
      namesNoOne(line, profile)
    },
  )

  it.each(['issuer', 'audience', 'expired'] as const)(
    'names the failed %s check with the claims the token carried',
    (check) => {
      const profile = work({ aud: 'another-client' })
      const line = signInDiagnostic('microsoft', profile, 'token_check', {
        check,
      })
      expect(Object.keys(line).sort()).toEqual(KEYS)
      expect(line).toEqual({
        message: 'sign-in refused',
        provider: 'microsoft',
        reason: 'token_check',
        error: null,
        check,
        account: 'work',
        carried: { email: true, xms_edov: true, idp: false },
        xms_edov: true,
      })
      namesNoOne(line, profile)
    },
  )

  it.each([
    { error: 'access_denied', kept: 'access_denied' },
    { error: 'invalid_code', kept: 'invalid_code' },
    { error: 'unable_to_get_user_info', kept: 'unable_to_get_user_info' },
    { error: 'AADSTS65004: User declined', kept: null },
    { error: 'ana@outlook.com', kept: null },
  ])(
    'a failure before any profile was read keeps $error only as a short code, with no claims',
    ({ error, kept }) => {
      const line = signInDiagnostic('microsoft', null, 'provider_error', {
        error,
      })
      expect(Object.keys(line).sort()).toEqual(KEYS)
      expect(line).toEqual({
        message: 'sign-in refused',
        provider: 'microsoft',
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
