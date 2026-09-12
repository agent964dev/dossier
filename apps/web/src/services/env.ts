import { Context } from 'effect'

/** Per-request Cloudflare bindings. Surface builders provide this tag once. */
export class WorkerEnv extends Context.Tag('@dossier/web/WorkerEnv')<
  WorkerEnv,
  Cloudflare.Env
>() {}
