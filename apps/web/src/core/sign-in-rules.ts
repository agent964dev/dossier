import type { PersonId } from '@dossier/contracts'

import type { SignInClaims, SignInProviderId } from '../ports/auth.ts'

/** The provider the stored email authority names, or none. Stored in account_emails and people. */
export type Authority = SignInProviderId | 'none'

/** What a provider says about the email it sent. */
export interface EmailTrust {
  /** The provider says this account controls the email now. */
  readonly confirmed: boolean
  /** The provider is the email authority for the email now. */
  readonly authority: boolean
}

const GMAIL = /@(gmail|googlemail)\.com$/

/** The lower-cased email a token carries, or empty when it carries none. */
export const emailOf = (profile: Readonly<Record<string, unknown>>): string =>
  typeof profile.email === 'string' ? profile.email.toLowerCase() : ''

/**
 * Google confirms an email when it says `email_verified`, and is the
 * authority for a verified Gmail address and for a Workspace account, which
 * carries a hosted domain.
 */
export const googleTrust = (
  profile: Readonly<Record<string, unknown>>,
): EmailTrust => {
  const email = emailOf(profile)
  const confirmed = email !== '' && profile.email_verified === true
  const hostedDomain = typeof profile.hd === 'string' && profile.hd !== ''
  return {
    confirmed,
    authority: confirmed && (GMAIL.test(email) || hostedDomain),
  }
}

/** The directory every personal Microsoft account's token names as its `tid`. */
export const PERSONAL_MICROSOFT_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad'

/** Microsoft's own consumer mail domains, matched on the whole lower-cased domain. */
// Source: goals/microsoft-sign-in/research/reports/consumer-domains.md, read 2026-10-20.
// Exact whole domains only; never extend by pattern or generated country forms.
export const MICROSOFT_CONSUMER_DOMAINS: ReadonlySet<string> = new Set([
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
])

/** The issuers a guest from a personal Microsoft account names as its `idp`. */
const PERSONAL_ACCOUNT_ISSUERS: ReadonlySet<unknown> = new Set([
  'live.com',
  `https://sts.windows.net/${PERSONAL_MICROSOFT_TENANT}/`,
  `https://login.microsoftonline.com/${PERSONAL_MICROSOFT_TENANT}/v2.0`,
])

/**
 * A personal account; a native work or school account of the directory that
 * issued the token; a guest there from a personal account; or a guest from
 * any other directory or provider.
 */
export type MicrosoftAccountKind =
  | 'personal'
  | 'work'
  | 'personal_guest'
  | 'guest'

export const microsoftAccountKind = (
  profile: Readonly<Record<string, unknown>>,
): MicrosoftAccountKind => {
  if (profile.tid === PERSONAL_MICROSOFT_TENANT) return 'personal'
  const { idp } = profile
  if (idp === undefined || idp === profile.iss) return 'work'
  return PERSONAL_ACCOUNT_ISSUERS.has(idp) ? 'personal_guest' : 'guest'
}

/** The whole domain after the email's last `@`. */
const domainOf = (email: string): string =>
  email.slice(email.lastIndexOf('@') + 1)

/**
 * Microsoft confirms an email, and is its authority, for a personal account
 * (or a guest from one) on one of Microsoft's own consumer domains, and for a
 * native work or school account whose directory verified the email's domain
 * (`xms_edov`). Microsoft's `email_verified` and verified-email claims are
 * never read.
 */
export const microsoftTrust = (
  profile: Readonly<Record<string, unknown>>,
): EmailTrust => {
  const email = emailOf(profile)
  if (!email.includes('@')) return { confirmed: false, authority: false }
  const kind = microsoftAccountKind(profile)
  const confirmed =
    kind === 'personal' || kind === 'personal_guest'
      ? MICROSOFT_CONSUMER_DOMAINS.has(domainOf(email))
      : kind === 'work' && profile.xms_edov === true
  return { confirmed, authority: confirmed }
}

/** The authority recorded for an account: its provider when it vouches for the email now. */
export const authorityOf = (
  claims: Pick<SignInClaims, 'provider' | 'authority'>,
): Authority => (claims.authority ? claims.provider : 'none')

export type LinkDecision =
  | { readonly kind: 'refuse' }
  /** `takeover`: the account ids to detach; empty when nothing is taken over. */
  | { readonly kind: 'link'; readonly takeover: readonly string[] }

/**
 * An account joins the person who already holds its email only when its
 * provider is the authority for the address now. It then takes over every
 * account of that person no provider vouches for.
 */
export const decideLink = (
  incoming: Authority,
  existing: readonly {
    readonly accountId: string
    readonly authority: Authority
  }[],
): LinkDecision =>
  incoming === 'none'
    ? { kind: 'refuse' }
    : {
        kind: 'link',
        takeover: existing
          .filter((account) => account.authority === 'none')
          .map((account) => account.accountId),
      }

/**
 * A known account's new email follows the provider when the provider confirms
 * it and no other person holds it. Otherwise the stored email stays, and the
 * confirmation is checked first.
 */
export const decideEmailChange = (i: {
  readonly confirmed: boolean
  readonly holder: PersonId | null
  readonly self: PersonId
}): 'update' | 'keep-unconfirmed' | 'keep-in-use' =>
  !i.confirmed
    ? 'keep-unconfirmed'
    : i.holder === null || i.holder === i.self
      ? 'update'
      : 'keep-in-use'

export type TokenCheck = 'issuer' | 'audience' | 'expired'

const GOOGLE_ISSUERS: ReadonlySet<unknown> = new Set([
  'https://accounts.google.com',
  'accounts.google.com',
])
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Seconds a token may be past its expiry, for clocks that differ. */
const CLOCK_SKEW = 30

const issuedBy = (
  provider: SignInProviderId,
  claims: Readonly<Record<string, unknown>>,
): boolean => {
  switch (provider) {
    case 'google':
      return GOOGLE_ISSUERS.has(claims.iss)
    case 'microsoft':
      return (
        typeof claims.tid === 'string' &&
        GUID.test(claims.tid) &&
        claims.iss === `https://login.microsoftonline.com/${claims.tid}/v2.0`
      )
  }
}

/** Why a token failed, or null when it passes. `now` in seconds. */
export const checkToken = (
  provider: SignInProviderId,
  claims: Readonly<Record<string, unknown>>,
  clientId: string,
  now: number,
): TokenCheck | null => {
  if (!issuedBy(provider, claims)) return 'issuer'
  const audience = claims.aud
  if (
    !(
      audience === clientId ||
      (Array.isArray(audience) && audience.includes(clientId))
    )
  ) {
    return 'audience'
  }
  if (typeof claims.exp !== 'number' || !(claims.exp > now - CLOCK_SKEW)) {
    return 'expired'
  }
  return null
}

/** The one log line for a refused or failed sign-in. Never an email, name or token. */
export interface SignInDiagnostic {
  readonly message: 'sign-in refused'
  readonly provider: SignInProviderId
  readonly reason:
    | 'not_confirmed'
    | 'no_email'
    | 'guest'
    | 'token_check'
    | 'provider_error'
  /** For provider_error: the sign-in library's redirect error code if it is [a-z_]{1,64}, else null. */
  readonly error: string | null
  readonly check: TokenCheck | null
  /** Which kind of Microsoft account signed in; null for Google. */
  readonly account: 'personal' | 'work' | 'personal_guest' | 'guest' | null
  /** Which of these claims the token carried; Microsoft only, null for Google. */
  readonly carried: {
    readonly email: boolean
    readonly xms_edov: boolean
    readonly idp: boolean
  } | null
  /** The value of xms_edov when it is a boolean; null otherwise. */
  readonly xms_edov: boolean | null
}

const ERROR_CODE = /^[a-z_]{1,64}$/

/** The claim fields of a diagnostic line, which only Microsoft's tokens fill. */
const claimFields = (
  provider: SignInProviderId,
  profile: Readonly<Record<string, unknown>> | null,
): Pick<SignInDiagnostic, 'account' | 'carried' | 'xms_edov'> =>
  provider !== 'microsoft' || profile === null
    ? { account: null, carried: null, xms_edov: null }
    : {
        account: microsoftAccountKind(profile),
        carried: {
          email: emailOf(profile) !== '',
          xms_edov: profile.xms_edov !== undefined,
          idp: profile.idp !== undefined,
        },
        xms_edov:
          typeof profile.xms_edov === 'boolean' ? profile.xms_edov : null,
      }

export const signInDiagnostic = (
  provider: SignInProviderId,
  /** null when the sign-in failed before a profile was read (provider_error). */
  profile: Readonly<Record<string, unknown>> | null,
  reason: SignInDiagnostic['reason'],
  detail: { readonly check?: TokenCheck; readonly error?: string },
): SignInDiagnostic => ({
  message: 'sign-in refused',
  provider,
  reason,
  error:
    reason === 'provider_error' &&
    detail.error !== undefined &&
    ERROR_CODE.test(detail.error)
      ? detail.error
      : null,
  check: detail.check ?? null,
  ...claimFields(provider, profile),
})
