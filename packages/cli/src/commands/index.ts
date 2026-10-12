import { login } from './login.ts'
import { logout } from './logout.ts'
import { ls } from './ls.ts'
import { pull } from './pull.ts'
import { push } from './push.ts'
import { read } from './read.ts'
import { update } from './update.ts'
import { whoami } from './whoami.ts'

/** Every verb, in the order help and the agent guide list them. */
export const verbs = [
  login,
  logout,
  whoami,
  update,
  push,
  pull,
  ls,
  read,
] as const
