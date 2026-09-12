import { Schema } from 'effect'

export const PolicyStats = Schema.Struct({
  hasInlineScript: Schema.Boolean,
  externalImageHosts: Schema.Array(Schema.String),
  stylesheetRefs: Schema.Array(Schema.String),
  embedHosts: Schema.Array(Schema.String),
})
export type PolicyStats = typeof PolicyStats.Type

export const PolicyResult = Schema.Struct({
  ok: Schema.Boolean,
  errors: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
  title: Schema.NullOr(Schema.String),
  stats: PolicyStats,
})
export type PolicyResult = typeof PolicyResult.Type

export const CssPolicyResult = Schema.Struct({
  ok: Schema.Boolean,
  errors: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
})
export type CssPolicyResult = typeof CssPolicyResult.Type
