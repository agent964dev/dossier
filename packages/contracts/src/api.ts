import { HttpApi, HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import { DossierError } from './errors.ts'
import { AgentKeyId, AgentKeySecret } from './ids.ts'
import { Person } from './person.ts'
import { PROTOCOL } from './protocol.ts'

export const Health = Schema.Struct({
  ok: Schema.Literal(true),
  service: Schema.Literal('dossier'),
  version: Schema.String,
  protocol: Schema.Literal(PROTOCOL),
  deployment: Schema.String,
  db: Schema.Literal('ok'),
})
export type Health = typeof Health.Type

export const KeyInfo = Schema.Struct({ id: AgentKeyId, name: Schema.String })
export type KeyInfo = typeof KeyInfo.Type

export const Me = Schema.Struct({
  person: Person,
  deployment: Schema.String,
  key: Schema.NullOr(KeyInfo),
})
export type Me = typeof Me.Type

export const DeviceToken = Schema.Struct({
  key: AgentKeySecret,
  name: Schema.String,
  deployment: Schema.String,
  person: Person,
})
export type DeviceToken = typeof DeviceToken.Type

export class SystemGroup extends HttpApiGroup.make('system').add(
  // unavailable
  HttpApiEndpoint.get('health', '/health').addSuccess(Health),
) {}

export class MeGroup extends HttpApiGroup.make('me')
  // sign_in_required
  .add(HttpApiEndpoint.get('me', '/me').addSuccess(Me))
  // sign_in_required (needs an agent key)
  .add(
    HttpApiEndpoint.del('revokeCurrentKey', '/keys/current').addSuccess(
      Schema.Void,
      { status: 204 },
    ),
  ) {}

export class DeviceGroup extends HttpApiGroup.make('device').add(
  // device_pending | slow_down | device_expired | access_denied
  HttpApiEndpoint.post('token', '/device/token')
    .setPayload(Schema.Struct({ deviceCode: Schema.String }))
    .addSuccess(DeviceToken),
) {}

export class DossierApi extends HttpApi.make('dossier')
  .add(SystemGroup)
  .add(MeGroup)
  .add(DeviceGroup)
  .addError(DossierError)
  .prefix('/_/api') {}
