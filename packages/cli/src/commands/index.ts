import { login } from './login.ts'
import { logout } from './logout.ts'
import { update } from './update.ts'
import { whoami } from './whoami.ts'

/** Every verb, in the order help and the agent guide list them. */
export const verbs = [login, logout, whoami, update] as const
