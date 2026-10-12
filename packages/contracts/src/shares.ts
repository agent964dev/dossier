import { Schema } from 'effect'

/**
 * The share grammar the CLI, the API and the share dialog agree on: whom a
 * share reaches and which role it gives.
 */
export type ShareRoleName = 'read' | 'respond' | 'write'

export type ShareTarget =
  | { readonly kind: 'email'; readonly email: string }
  /** A team's name in the tree's workspace. */
  | { readonly kind: 'team'; readonly team: string }
  | { readonly kind: 'workspace' }
  | { readonly kind: 'anyone' }

export const SHARE_ROLES: readonly ShareRoleName[] = [
  'read',
  'respond',
  'write',
]

const EMAIL = /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/

/** A well formed email address, as shares and invitations take them. */
export const isShareEmail = (value: string): boolean =>
  value.length <= 254 && EMAIL.test(value)

/** A team's name as `team:<name>` carries it. */
const isTeamName = (value: string): boolean =>
  value.trim() === value && value.length > 0 && value.length <= 60

export const ShareTargetSchema: Schema.Schema<ShareTarget> = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('email'),
    email: Schema.String.pipe(
      Schema.filter((email) => isShareEmail(email) || 'Not an email address'),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal('team'),
    team: Schema.String.pipe(
      Schema.filter((team) => isTeamName(team) || 'Not a team name'),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal('workspace') }),
  Schema.Struct({ kind: Schema.Literal('anyone') }),
)

export const ShareRoleSchema = Schema.Literal('read', 'respond', 'write')

export const ShareSpecSchema = Schema.Struct({
  target: ShareTargetSchema,
  role: ShareRoleSchema,
})
export type ShareSpec = typeof ShareSpecSchema.Type

/** `sara@acme.com` · `team:Design` · `workspace` · `anyone`, else null. */
export const parseShareTarget = (input: string): ShareTarget | null => {
  const value = input.trim()
  if (value === 'workspace') return { kind: 'workspace' }
  if (value === 'anyone') return { kind: 'anyone' }
  if (value.startsWith('team:')) {
    const team = value.slice('team:'.length)
    return isTeamName(team) ? { kind: 'team', team } : null
  }
  return isShareEmail(value)
    ? { kind: 'email', email: value.toLowerCase() }
    : null
}

/** The inverse of parseShareTarget, for CLI output. */
export const formatShareTarget = (target: ShareTarget): string => {
  switch (target.kind) {
    case 'email':
      return target.email
    case 'team':
      return `team:${target.team}`
    case 'workspace':
      return 'workspace'
    case 'anyone':
      return 'anyone'
  }
}

const isRole = (value: string): value is ShareRoleName =>
  (SHARE_ROLES as readonly string[]).includes(value)

/** `<target>:<role>`, split at the last `:`, else null. */
export const parseShareSpec = (input: string): ShareSpec | null => {
  const at = input.lastIndexOf(':')
  if (at <= 0) return null
  const role = input.slice(at + 1)
  if (!isRole(role)) return null
  const target = parseShareTarget(input.slice(0, at))
  return target === null ? null : { target, role }
}
