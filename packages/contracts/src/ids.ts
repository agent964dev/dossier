import { Schema } from 'effect'

export const PersonId = Schema.String.pipe(Schema.brand('PersonId'))
export type PersonId = typeof PersonId.Type

export const SessionId = Schema.String.pipe(Schema.brand('SessionId'))
export type SessionId = typeof SessionId.Type

export const AgentKeyId = Schema.String.pipe(Schema.brand('AgentKeyId'))
export type AgentKeyId = typeof AgentKeyId.Type

export const TreeId = Schema.String.pipe(Schema.brand('TreeId'))
export type TreeId = typeof TreeId.Type

export const NodeId = Schema.String.pipe(Schema.brand('NodeId'))
export type NodeId = typeof NodeId.Type

export const WorkspaceId = Schema.String.pipe(Schema.brand('WorkspaceId'))
export type WorkspaceId = typeof WorkspaceId.Type

/** 32 random bytes in base64url after `dsk_`, shown once when created. */
export const AgentKeySecret = Schema.TemplateLiteral('dsk_', Schema.String)
export type AgentKeySecret = typeof AgentKeySecret.Type
