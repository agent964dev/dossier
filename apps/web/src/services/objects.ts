import { Context, Effect, Layer } from 'effect'

import { WorkerEnv } from './env'
import { StorageError } from './errors'

export interface ObjectsService {
  readonly bucket: R2Bucket
  readonly put: (
    key: string,
    value: Uint8Array | ArrayBuffer | ReadableStream,
    options?: R2PutOptions,
  ) => Effect.Effect<R2Object | null, StorageError>
  readonly get: (key: string) => Effect.Effect<R2ObjectBody | null, StorageError>
  readonly head: (key: string) => Effect.Effect<R2Object | null, StorageError>
  readonly delete: (key: string) => Effect.Effect<void, StorageError>
}

export class Objects extends Context.Tag('@dossier/web/Objects')<
  Objects,
  ObjectsService
>() {}

export function makeObjects(bucket: R2Bucket): ObjectsService {
  return {
    bucket,
    put: (key, value, options) =>
      Effect.tryPromise({
        try: () => bucket.put(key, value, options),
        catch: (cause) => new StorageError({ operation: `R2 put ${key}`, cause }),
      }),
    get: (key) =>
      Effect.tryPromise({
        try: () => bucket.get(key),
        catch: (cause) => new StorageError({ operation: `R2 get ${key}`, cause }),
      }),
    head: (key) =>
      Effect.tryPromise({
        try: () => bucket.head(key),
        catch: (cause) => new StorageError({ operation: `R2 head ${key}`, cause }),
      }),
    delete: (key) =>
      Effect.tryPromise({
        try: () => bucket.delete(key),
        catch: (cause) => new StorageError({ operation: `R2 delete ${key}`, cause }),
      }),
  }
}

export const ObjectsLive = Layer.effect(
  Objects,
  Effect.map(WorkerEnv, (env) => makeObjects(env.OBJECTS)),
)

export const ObjectsLayer = (bucket: R2Bucket) =>
  Layer.succeed(Objects, makeObjects(bucket))
