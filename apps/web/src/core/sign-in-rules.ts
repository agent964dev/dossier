import type { PersonId } from '@dossier/contracts'

import type { GoogleClaims } from '../ports/auth.ts'

/** Whether Google is the authority for an email right now. */
export type Authority = 'google' | 'none'

const GMAIL = /@(gmail|googlemail)\.com$/

/**
 * Google is the authority for a verified Gmail address, and for a Workspace
 * account, which carries a hosted domain.
 */
export const authorityOf = (
  claims: Pick<GoogleClaims, 'email' | 'email_verified' | 'hd'>,
): Authority =>
  claims.email_verified === true &&
  (GMAIL.test(claims.email.toLowerCase()) ||
    (typeof claims.hd === 'string' && claims.hd !== ''))
    ? 'google'
    : 'none'

export type LinkDecision =
  | { readonly kind: 'refuse' }
  /** `takeover`: the account ids to detach; empty when nothing is taken over. */
  | { readonly kind: 'link'; readonly takeover: readonly string[] }

/**
 * A Google account joins the person who already holds its email only when
 * Google is the authority for the address now. It then takes over every
 * account of that person Google was not the authority for.
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
 * A known account's email follows Google unless the new address belongs to
 * another person, in which case the old one is kept.
 */
export const decideEmailChange = (
  newEmail: string,
  holder: PersonId | null,
  self: PersonId,
): 'update' | 'keep-old' =>
  holder === null || holder === self ? 'update' : 'keep-old'
