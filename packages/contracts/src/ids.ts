import { Schema } from 'effect'

export const PersonId = Schema.String.pipe(Schema.brand('PersonId'))
export type PersonId = typeof PersonId.Type

export const SessionId = Schema.String.pipe(Schema.brand('SessionId'))
export type SessionId = typeof SessionId.Type

export const AgentKeyId = Schema.String.pipe(Schema.brand('AgentKeyId'))
export type AgentKeyId = typeof AgentKeyId.Type

/**
 * A tree's ID names its content host, so it is a DNS label: 20 lowercase
 * letters and digits, never a hyphen.
 */
export const TreeId = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9]{20}$/),
  Schema.brand('TreeId'),
)
export type TreeId = typeof TreeId.Type

export const NodeId = Schema.String.pipe(Schema.brand('NodeId'))
export type NodeId = typeof NodeId.Type

export const WorkspaceId = Schema.String.pipe(Schema.brand('WorkspaceId'))
export type WorkspaceId = typeof WorkspaceId.Type

export const PushId = Schema.String.pipe(Schema.brand('PushId'))
export type PushId = typeof PushId.Type

export const VersionId = Schema.String.pipe(Schema.brand('VersionId'))
export type VersionId = typeof VersionId.Type

export const ShareId = Schema.String.pipe(Schema.brand('ShareId'))
export type ShareId = typeof ShareId.Type

export const OpId = Schema.String.pipe(Schema.brand('OpId'))
export type OpId = typeof OpId.Type

/** A blob's name: the lowercase hex SHA-256 of its bytes. */
export const Sha256 = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{64}$/),
  Schema.brand('Sha256'),
)
export type Sha256 = typeof Sha256.Type

/** A tree's count of changes to authored files; frame URLs pin it. */
export const AuthoredSeq = Schema.Int.pipe(
  Schema.nonNegative(),
  Schema.brand('AuthoredSeq'),
)
export type AuthoredSeq = typeof AuthoredSeq.Type

/** A tree's count of events. */
export const EventSeq = Schema.Int.pipe(
  Schema.nonNegative(),
  Schema.brand('EventSeq'),
)
export type EventSeq = typeof EventSeq.Type

/** Pushes count per tree from 1. */
export const PushNumber = Schema.Int.pipe(
  Schema.positive(),
  Schema.brand('PushNumber'),
)
export type PushNumber = typeof PushNumber.Type

/** 32 random bytes in base64url after `dsk_`, shown once when created. */
export const AgentKeySecret = Schema.TemplateLiteral('dsk_', Schema.String)
export type AgentKeySecret = typeof AgentKeySecret.Type
