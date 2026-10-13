import { Context } from 'effect'

/** The Worker's environment: every binding, variable and secret. */
export class Bindings extends Context.Tag('Bindings')<Bindings, Env>() {}
