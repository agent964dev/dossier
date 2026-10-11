import { Schema } from 'effect'

import { PersonId } from './ids.ts'

export const Person = Schema.Struct({
  id: PersonId,
  email: Schema.String,
  name: Schema.String,
  image: Schema.NullOr(Schema.String),
})
export type Person = typeof Person.Type
