import { CSRF_HEADER } from '@dossier/contracts'
import { createMiddleware, createStart } from '@tanstack/react-start'

/**
 * Every server function call carries Dossier's CSRF header, which a page on
 * another origin cannot send without a preflight Dossier never answers.
 */
const csrfHeader = createMiddleware({ type: 'function' }).client(({ next }) =>
  next({ headers: { [CSRF_HEADER]: '1' } }),
)

export const startInstance = createStart(() => ({
  functionMiddleware: [csrfHeader],
}))
