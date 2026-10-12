import { exportPage } from './export.ts'
import { login } from './login.ts'
import { logout } from './logout.ts'
import { ls } from './ls.ts'
import { pull } from './pull.ts'
import { push } from './push.ts'
import { read } from './read.ts'
import { share } from './share.ts'
import { update } from './update.ts'
import { watch } from './watch.ts'
import { whoami } from './whoami.ts'

/** Every verb, in the order help and the agent guide list them. */
export const verbs = [
  login,
  logout,
  whoami,
  update,
  push,
  pull,
  share,
  ls,
  read,
  exportPage,
  watch,
] as const
