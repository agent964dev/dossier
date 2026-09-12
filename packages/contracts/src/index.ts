import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from '@effect/platform'
import { PolicyResult } from '@dossier/policy'
import { Schema } from 'effect'

export {
  CssPolicyResult,
  PolicyResult,
  PolicyStats,
} from '@dossier/policy'
export type {
  CssPolicyResultType,
  PolicyResultType,
  PolicyStatsType,
} from '@dossier/policy'

export const HealthzResponse = Schema.Struct({
  ok: Schema.Literal(true),
  service: Schema.Literal('dossier'),
  version: Schema.String,
})
export type HealthzResponse = typeof HealthzResponse.Type

export const PolicyCheckPayload = HttpApiSchema.Text({
  contentType: 'text/html',
})
export type PolicyCheckPayload = typeof PolicyCheckPayload.Type

export const SystemApiGroup = HttpApiGroup.make('system')
  .add(
    HttpApiEndpoint.get('healthz', '/api/healthz').addSuccess(
      HealthzResponse,
    ),
  )
  .add(
    HttpApiEndpoint.post('policyCheck', '/api/policy/check')
      .setPayload(PolicyCheckPayload)
      .addSuccess(PolicyResult),
  )

export const DossierApi = HttpApi.make('dossier').add(SystemApiGroup)
