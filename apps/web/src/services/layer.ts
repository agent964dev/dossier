import { Layer } from 'effect'

import { AccessLive } from './access'
import { AllowlistLive } from './allowlist'
import { DbLive } from './db'
import { DocumentsLive } from './documents'
import { IdsLive } from './ids'
import { ObjectsLive } from './objects'
import { PrincipalLive } from './principal'
import { PublishLive } from './publish'
import { ServingLive } from './serving'
import { SessionLive } from './session'
import { ShooLive } from './shoo'

const FoundationLive = Layer.mergeAll(DbLive, ObjectsLive, IdsLive, SessionLive)
const AuthenticationLive = Layer.mergeAll(PrincipalLive, AccessLive).pipe(
  Layer.provideMerge(FoundationLive),
)
const SignInLive = Layer.mergeAll(AllowlistLive, ShooLive).pipe(
  Layer.provideMerge(AuthenticationLive),
)

/** All phase-one services; surface builders only need to provide WorkerEnv. */
export const CoreServicesLive = Layer.mergeAll(
  PublishLive,
  DocumentsLive,
  ServingLive,
).pipe(Layer.provideMerge(SignInLive))
