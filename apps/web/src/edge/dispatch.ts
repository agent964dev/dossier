import {
  dossierError,
  isDossierError,
  PROTOCOL,
  PROTOCOL_HEADER,
  treeIdForHost,
  type TreeId,
} from '@dossier/contracts'
import tanstack from '@tanstack/react-start/server-entry'
import { Cause, Effect, Exit, Option } from 'effect'

import {
  Config,
  runtimeFor,
  SignIn,
  type CoreRuntime,
  type CoreServices,
  type DeploymentConfig,
} from '../core/index.ts'
import { apiHandlerFor } from './api/index.ts'
import { callerFor, requestIdOf } from './caller.ts'
import {
  codeResponse,
  errorResponse,
  normalizeApiError,
  notFoundPage,
  plainErrorPage,
  plainNotFound,
  withCommonHeaders,
} from './respond.ts'
import { screenScope, type ScreenScope } from './screens.ts'

export type RequestKind =
  | 'link'
  | 'frame'
  | 'api-read'
  | 'api-write'
  | 'upgrade'
  | 'auth'
  | 'screen'
  | 'screen-call'
  | 'base'
  | 'static'
  | 'fonts'
  | 'legacy'

export type HostMatch =
  | { readonly kind: 'main' }
  | { readonly kind: 'content'; readonly treeId: TreeId }

/** The one host lookup: the main host, or a tree's own content host. */
export const resolveHost = (
  url: URL,
  config: DeploymentConfig,
): HostMatch | null => {
  if (url.host === config.origin.host) return { kind: 'main' }
  const treeId = treeIdForHost(config.contentHost, url.host)
  return treeId === null ? null : { kind: 'content', treeId }
}

const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`)

/** What a request is. A content host serves only frames and the base layer. */
export const classify = (
  request: Request,
  host: HostMatch,
): RequestKind | null => {
  const { pathname } = new URL(request.url)
  if (under(pathname, '/_/v')) return host.kind === 'content' ? 'frame' : null
  if (under(pathname, '/_/base')) return 'base'
  if (host.kind === 'content') return null
  if (under(pathname, '/_/auth')) return 'auth'
  if (under(pathname, '/_/api')) {
    if (
      pathname === '/_/api/watch' &&
      request.headers.get('upgrade')?.toLowerCase() === 'websocket'
    ) {
      return 'upgrade'
    }
    return request.method === 'GET' || request.method === 'HEAD'
      ? 'api-read'
      : 'api-write'
  }
  if (under(pathname, '/_/app')) return 'static'
  if (under(pathname, '/_/fonts')) return 'fonts'
  if (under(pathname, '/_serverFn')) return 'screen-call'
  if (pathname === '/' || pathname.startsWith('/_/')) return 'screen'
  if (under(pathname, '/api') || under(pathname, '/cli')) return 'legacy'
  return 'link'
}

/** Kinds whose failure is shown as a document rather than an error body. */
const isDocumentKind = (kind: RequestKind) =>
  kind === 'screen' || kind === 'link'

const forbiddenServiceWorker = () =>
  new Response('Dossier serves no service worker scripts.\n', {
    status: 403,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  })

const isHtml = (response: Response) =>
  response.headers.get('content-type')?.includes('text/html') === true

/** Serves one request with the given runtime. */
export const serve = async (
  request: Request,
  env: Env,
  runtime: CoreRuntime,
): Promise<Response> => {
  // No Dossier response is ever a service worker, on any host.
  if (request.headers.get('service-worker') === 'script') {
    return forbiddenServiceWorker()
  }
  const requestId = requestIdOf(request)
  let config: DeploymentConfig
  try {
    config = await runtime.runPromise(Config)
  } catch (error) {
    console.error('Dossier could not start', { requestId, error })
    return plainErrorPage(requestId)
  }
  const url = new URL(request.url)
  const host = resolveHost(url, config)
  if (host === null) return plainNotFound()
  const kind = classify(request, host)
  if (kind === null) {
    return withCommonHeaders(plainNotFound(), null, [], host.kind)
  }

  let setCookie: readonly string[] = []
  const finish = (response: Response) =>
    withCommonHeaders(response, kind, setCookie, host.kind)

  try {
    const response = await route()
    return finish(response)
  } catch (error) {
    if (isDossierError(error)) {
      if (isDocumentKind(kind)) {
        return finish(
          error.code === 'unavailable'
            ? plainErrorPage(requestId)
            : notFoundPage(requestId),
        )
      }
      return finish(errorResponse(error, requestId))
    }
    console.error('Request failed', {
      requestId,
      kind,
      path: url.pathname,
      error,
    })
    return finish(
      isDocumentKind(kind)
        ? plainErrorPage(requestId)
        : codeResponse('unavailable', requestId),
    )
  }

  async function caller() {
    const found = await run(
      runtime,
      callerFor(kind!, request, config.origin.origin),
    )
    setCookie = found.setCookie
    return found.caller
  }

  async function route(): Promise<Response> {
    switch (kind) {
      case 'auth': {
        return run(
          runtime,
          Effect.flatMap(SignIn, (signIn) => signIn.handle(request)),
        )
      }
      case 'api-read':
      case 'api-write': {
        const protocol = request.headers.get(PROTOCOL_HEADER)
        if (protocol !== null && protocol.trim() !== String(PROTOCOL)) {
          throw dossierError(
            'protocol_mismatch',
            `This deployment speaks protocol ${PROTOCOL}.`,
            'Update the CLI with dossier update.',
          )
        }
        const who = await caller()
        const handler = await apiHandlerFor(runtime)
        return normalizeApiError(await handler(request, who), requestId)
      }
      case 'upgrade':
      case 'frame':
      case 'fonts':
      case 'legacy':
        throw dossierError('not_found')
      case 'static':
        return env.ASSETS.fetch(request)
      case 'base': {
        const version = url.pathname.split('/')[3]
        if (version !== config.baseVersion) return plainNotFound()
        return env.ASSETS.fetch(request)
      }
      case 'link': {
        const who = await caller()
        if (who.person === null) {
          const next = `${url.pathname}${url.search}`
          const target = new URL('/_/sign-in', config.origin)
          target.searchParams.set('next', next)
          return new Response(null, {
            status: 302,
            headers: {
              location: `${target.pathname}${target.search}`,
              'cache-control': 'no-store',
            },
          })
        }
        throw dossierError('not_found')
      }
      case 'screen':
      case 'screen-call': {
        const scope: ScreenScope = {
          caller: await caller(),
          runtime,
          unavailable: false,
        }
        const response = await screenScope.run(scope, () =>
          tanstack.fetch(request),
        )
        if (kind === 'screen' && scope.unavailable && isHtml(response)) {
          return plainErrorPage(requestId)
        }
        return response
      }
    }
    throw dossierError('not_found')
  }
}

/** Runs an effect; a typed failure is thrown as itself, a defect as its cause. */
const run = async <A, E>(
  runtime: CoreRuntime,
  effect: Effect.Effect<A, E, CoreServices>,
): Promise<A> => {
  const exit = await runtime.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Cause.failureOption(exit.cause)
  throw Option.isSome(failure) ? failure.value : Cause.squash(exit.cause)
}

/** Every request: one host lookup, one classification, one caller rule. */
export const dispatch = (
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> => serve(request, env, runtimeFor(env))
