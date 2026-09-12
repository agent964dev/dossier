import { Layer } from 'effect'

import { AccessLive } from './access'
import { AllowlistLive } from './allowlist'
import { AssetsLive } from './assets'
import { DbLive } from './db'
import { DocumentsLive } from './documents'
import { IdsLive } from './ids'
import { ObjectsLive } from './objects'
import { PrincipalLive } from './principal'
import { PublishLive } from './publish'
import { ServingLive } from './serving'
import { SharesLive } from './shares'
import { TreeLive } from './tree'
import { SessionLive } from './session'
import { ShooLive } from './shoo'

const FoundationLive = Layer.mergeAll(DbLive, ObjectsLive, IdsLive, SessionLive)
const AuthenticationLive = Layer.mergeAll(PrincipalLive, AccessLive).pipe(
  Layer.provideMerge(FoundationLive),
)
const SignInLive = Layer.mergeAll(AllowlistLive, ShooLive).pipe(
  Layer.provideMerge(AuthenticationLive),
)

/** Core document, asset, tree, ACL, publication, and authentication services. */
export const CoreServicesLive = Layer.mergeAll(
  AssetsLive,
  PublishLive,
  DocumentsLive,
  ServingLive,
  SharesLive,
  TreeLive,
).pipe(Layer.provideMerge(SignInLive))
