import { Schema } from 'effect'

/** The limit values: the defaults, or what a super admin saved over them. */
export interface LimitValues {
  /** One file in a push. */
  readonly fileBytes: number
  readonly pushFiles: number
  readonly pushBytes: number
  /** Per agent key. */
  readonly pushesPerMinute: number
  /** Per person. */
  readonly sendsPerMinute: number
  /** One file uploaded through a form. */
  readonly uploadBytes: number
  /** One data file written by a form or the page client. */
  readonly dataFileBytes: number
  /** Per workspace, history included. */
  readonly storageBytes: number
  readonly webhooksPerWorkspace: number
}

const MiB = 1024 * 1024
const GiB = 1024 * MiB

export const DEFAULT_LIMITS: LimitValues = {
  fileBytes: 50 * MiB,
  pushFiles: 2_000,
  pushBytes: 500 * MiB,
  pushesPerMinute: 30,
  sendsPerMinute: 30,
  uploadBytes: 10 * MiB,
  dataFileBytes: 1 * MiB,
  storageBytes: 10 * GiB,
  webhooksPerWorkspace: 10,
}

export const DEFAULT_RETENTION_DAYS = 30

const Positive = Schema.Int.pipe(Schema.positive())

/** What a super admin may save: any of the fields, each a positive integer. */
export const LimitValuesSchema = Schema.partial(
  Schema.Struct({
    fileBytes: Positive,
    pushFiles: Positive,
    pushBytes: Positive,
    pushesPerMinute: Positive,
    sendsPerMinute: Positive,
    uploadBytes: Positive,
    dataFileBytes: Positive,
    storageBytes: Positive,
    webhooksPerWorkspace: Positive,
  }),
)
