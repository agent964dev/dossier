import { comment } from './comment.ts'
import { exportPage } from './export.ts'
import { diff } from './diff.ts'
import { log } from './log.ts'
import { login } from './login.ts'
import { logout } from './logout.ts'
import { ls } from './ls.ts'
import { mv } from './mv.ts'
import { pull } from './pull.ts'
import { push } from './push.ts'
import { read } from './read.ts'
import { restore } from './restore.ts'
import { rm } from './rm.ts'
import { search } from './search.ts'
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
  rm,
  mv,
  share,
  ls,
  read,
  exportPage,
  comment,
  search,
  watch,
  log,
  diff,
  restore,
] as const
