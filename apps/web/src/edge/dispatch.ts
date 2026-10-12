import {
  dossierError,
  isDossierError,
  parseTarget,
  PROTOCOL,
  PROTOCOL_HEADER,
  treeIdForHost,
  type DossierError,
  type LinkRef,
  type TreeId,
} from '@dossier/contracts'
import tanstack from '@tanstack/react-start/server-entry'
import { Cause, Effect, Exit, Option } from 'effect'

import {
  Access,
  Background,
  backgroundFor,
  backgroundInline,
  BaseLayer,
  basePathOf,
  Config,
  CurrentCaller,
  LookSettings,
  Pages,
  runtimeFor,
  SignIn,
  TreeStore,
  treeRefOf,
  Watch,
  type BackgroundService,
  type Caller,
  type Served,
  type CoreRuntime,
  type CoreServices,
  type DeploymentConfig,
} from '../core/index.ts'
import { apiHandlerFor } from './api/index.ts'
import { isLegacy, legacyResponse } from './legacy.ts'
import {
  bearerOf,
  callerFor,
  newVisitorCookie,
  frameCallerFor,
  framePathOf,
  requestIdOf,
} from './caller.ts'
import {
  agentResponse,
  baseResponse,
  codeResponse,
  errorResponse,
  frameFailure,
  fontResponse,
  frameResponse,
  logoResponse,
  lookSheetResponse,
  normalizeApiError,
  notFoundPage,
  plainErrorPage,
  plainNotFound,
  redirectTo,
  renderShell,
  withCommonHeaders,
} from './respond.ts'
import {
  END_SESSION_COOKIES,
  screenScope,
  type ScreenScope,
} from './screens.ts'

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
  | 'look'
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
  const url = new URL(request.url)
  const { pathname } = url
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
  if (under(pathname, '/_/look')) return 'look'
  // CLI 0.2.x: its paths, and its keys anywhere outside /_/.
  if (isLegacy(url, request.headers)) return 'legacy'
  if (under(pathname, '/_serverFn')) return 'screen-call'
  if (pathname === '/' || pathname.startsWith('/_/')) return 'screen'
  return 'link'
}

/** API writes that need no one signed in: the CLI's device login. */
const ANONYMOUS_WRITES: ReadonlySet<string> = new Set(['/_/api/device/token'])

/**
 * API writes a visitor makes on their anonymous session: asking for a view
 * handle of a public page.
 */
const VISITOR_WRITES: ReadonlySet<string> = new Set(['/_/api/view'])

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

/**
 * `Accept` names text/markdown with a q above 0: an agent asking a link for
 * the page's agent version.
 */
export const acceptsMarkdown = (accept: string | null): boolean =>
  (accept ?? '').split(',').some((part) => {
    const [type = '', ...params] = part.split(';').map((p) => p.trim())
    if (type.toLowerCase() !== 'text/markdown') return false
    const q = params.find((p) => p.toLowerCase().startsWith('q='))
    return q === undefined || Number(q.slice(2)) > 0
  })

const isHtml = (response: Response) =>
  response.headers.get('content-type')?.includes('text/html') === true

/**
 * Serves one request with the given runtime. Work after a commit runs on
 * `background`; without one it finishes before the response.
 */
export const serve = async (
  request: Request,
  env: Env,
  runtime: CoreRuntime,
  background: BackgroundService = backgroundInline,
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
    // API callers still get the one error body and the protocol header.
    return under(new URL(request.url).pathname, '/_/api')
      ? withCommonHeaders(
          codeResponse('unavailable', requestId),
          'api-read',
          [],
          'main',
        )
      : plainErrorPage(requestId)
  }
  const url = new URL(request.url)
  const host = resolveHost(url, config)
  if (host === null) return plainNotFound()
  const kind = classify(request, host)
  if (kind === null) {
    // A content host answers anything else as a frame that is not there,
    // with the content headers, so even its 404 runs sandboxed.
    return withCommonHeaders(
      host.kind === 'content' ? frameFailure(404) : plainNotFound(),
      null,
      [],
      host.kind,
    )
  }

  let setCookie: readonly string[] = []
  const finish = (response: Response) =>
    withCommonHeaders(response, kind, setCookie, host.kind)
  // A link asked with `Accept: text/markdown` or an agent key answers an
  // agent: never the sign-in redirect or a page, always the error body.
  const agentAsked =
    kind === 'link' &&
    (acceptsMarkdown(request.headers.get('accept')) ||
      bearerOf(request.headers.get('authorization')).kind !== 'none')

  try {
    const response = await route()
    return finish(response)
  } catch (error) {
    if (isDossierError(error)) {
      if (isDocumentKind(kind) && !agentAsked) {
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
      isDocumentKind(kind) && !agentAsked
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

  /** Every API request, upgrades included, speaks this deployment's protocol. */
  function checkProtocol(): void {
    const protocol = request.headers.get(PROTOCOL_HEADER)
    if (protocol !== null && protocol.trim() !== String(PROTOCOL)) {
      throw dossierError(
        'protocol_mismatch',
        `This deployment speaks protocol ${PROTOCOL}.`,
        'Update the CLI with dossier update.',
      )
    }
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
        checkProtocol()
        const who = await caller()
        // A write by no one is refused before its body is read, so an
        // anonymous caller learns nothing from how a payload is checked.
        const visitorWrite =
          who.via.kind === 'visitor' &&
          who.via.anonSessionId !== null &&
          VISITOR_WRITES.has(url.pathname)
        if (
          kind === 'api-write' &&
          who.person === null &&
          !ANONYMOUS_WRITES.has(url.pathname) &&
          !visitorWrite
        ) {
          throw dossierError(
            'sign_in_required',
            'Sign in first.',
            'Sign in with Google, or send an agent key.',
          )
        }
        const handler = await apiHandlerFor(runtime)
        return normalizeApiError(
          await handler(request, who, background),
          requestId,
        )
      }
      case 'upgrade':
        return upgrade()
      case 'fonts':
        return fontFile()
      case 'look':
        return lookFile()
      case 'legacy':
        return legacyResponse(request)
      case 'frame':
        return frame()
      case 'static':
        return env.ASSETS.fetch(request)
      case 'base':
        return baseFile()
      case 'link':
        return link()
      case 'screen':
      case 'screen-call':
        return screen(await caller())
    }
    throw dossierError('not_found')
  }

  /**
   * A watch of a tree's paths: the access check first, then the tree's hub
   * answers with the socket, which passes through as it is.
   */
  async function upgrade(): Promise<Response> {
    checkProtocol()
    const who = await caller()
    const accepted = await runAs(
      who,
      Effect.flatMap(Watch, (watch) =>
        watch.accept({
          request,
          tree: url.searchParams.get('tree') ?? '',
          paths: url.searchParams.getAll('path'),
        }),
      ),
    )
    if (isDossierError(accepted)) throw accepted
    return accepted
  }

  /** A TanStack screen, rendered as the caller. */
  async function screen(who: Caller, status?: number): Promise<Response> {
    const scope: ScreenScope = {
      caller: who,
      runtime,
      background,
      unavailable: false,
    }
    const response = await screenScope.run(scope, () => tanstack.fetch(request))
    if (scope.endSession === true) setCookie = END_SESSION_COOKIES
    if (kind !== 'screen-call' && scope.unavailable && isHtml(response)) {
      return plainErrorPage(requestId)
    }
    if (status === undefined || !isHtml(response)) return response
    return new Response(response.body, {
      status,
      headers: response.headers,
    })
  }

  /** The sign-in page, continuing to this link afterwards. */
  function signInFirst(): Response {
    const target = new URL('/_/sign-in', config.origin)
    target.searchParams.set('next', `${url.pathname}${url.search}`)
    return redirectTo(`${target.pathname}${target.search}`, 302)
  }

  /** Who may open what is decided before anything is said about a path. */
  async function link(): Promise<Response> {
    const who = await caller()
    const wantsAgent = agentAsked || who.via.kind === 'agent'
    const denied = (error: DossierError) =>
      wantsAgent
        ? errorResponse(error, requestId)
        : error.code === 'sign_in_required'
          ? signInFirst()
          : // The one no-access page, at the asked link, for missing and
            // unreadable alike.
            screen(who, 404)
    const segments = url.pathname.slice(1).split('/')
    // `/<workspace>` and `/<workspace>/`: the workspace's home, for members.
    if (
      segments.length === 1 ||
      (segments.length === 2 && segments[1] === '')
    ) {
      const name = segments[0] ?? ''
      const member = await runAs(
        who,
        Effect.gen(function* () {
          const store = yield* TreeStore
          const access = yield* Access
          return yield* access.member(yield* store.workspace(name))
        }),
      )
      if (isDossierError(member)) return denied(member)
      return redirectTo(`/?w=${encodeURIComponent(member.workspace.name)}`, 302)
    }
    const ref: LinkRef | null = parseTarget(url.href, config.origin)
    if (ref === null)
      return denied(
        dossierError(who.person === null ? 'sign_in_required' : 'not_found'),
      )
    const served = await runAs(
      who,
      Effect.flatMap(Pages, (pages) => pages.open({ ref, wantsAgent })),
    )
    if (isDossierError(served)) {
      if (served.code === 'unavailable') throw served
      return denied(served)
    }
    // An agent's read follows the link's redirects itself.
    if (wantsAgent) return agentResponse(served, ref)
    // `/<workspace>/<tree>` gains its slash, once the root may be opened.
    if (segments.length === 2) {
      return redirectTo(`${url.pathname}/${url.search}`, 301)
    }
    return answer(served, who)
  }

  async function answer(served: Served, who: Caller): Promise<Response> {
    switch (served.kind) {
      case 'shell':
        // A visitor's first page gives them an anonymous session, which
        // binds their view handles to this browser.
        if (
          who.person === null &&
          who.via.kind === 'visitor' &&
          who.via.anonSessionId === null
        ) {
          setCookie = [...setCookie, newVisitorCookie()]
        }
        return renderShell(served.boot)
      case 'listing':
        return screen(who)
      case 'redirect':
        return redirectTo(served.to, served.status)
      default:
        throw new Error(`A link cannot answer ${served.kind}`)
    }
  }

  /**
   * /_/base/<version>/<path>: this build's version from Static Assets, any
   * older one from the copy each deploy keeps in R2.
   */
  async function baseFile(): Promise<Response> {
    const [, , , version = '', ...rest] = url.pathname.split('/')
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plainNotFound()
    }
    if (version === config.baseVersion) return env.ASSETS.fetch(request)
    const file = await run(
      runtime,
      Effect.flatMap(BaseLayer, (base) => {
        const path = basePathOf(rest)
        return path === null ? Effect.succeed(null) : base.file(version, path)
      }),
    )
    if (file === null) return plainNotFound()
    return baseResponse(file, request.method === 'HEAD')
  }

  /** /_/fonts/<sha256>.<ext>: a font the Look copied or a super admin uploaded. */
  async function fontFile(): Promise<Response> {
    const name = url.pathname.slice('/_/fonts/'.length)
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plainNotFound()
    }
    const file = await run(
      runtime,
      Effect.flatMap(LookSettings, (look) => look.font(name)),
    )
    if (file === null) return plainNotFound()
    return fontResponse(file, request.method === 'HEAD')
  }

  /**
   * /_/look/<version>.css, the current Look's stylesheet, and
   * /_/look/logo-<sha256>. Public, like fonts: no caller is read.
   */
  async function lookFile(): Promise<Response> {
    const name = url.pathname.slice('/_/look/'.length)
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plainNotFound()
    }
    const head = request.method === 'HEAD'
    if (name.startsWith('logo-')) {
      const file = await run(
        runtime,
        Effect.flatMap(LookSettings, (look) => look.logo(name.slice(5))),
      )
      return file === null ? plainNotFound() : logoResponse(file, head)
    }
    const version = /^([0-9a-f]{16})\.css$/.exec(name)?.[1]
    if (version === undefined) return plainNotFound()
    const css = await run(
      runtime,
      Effect.flatMap(LookSettings, (look) => look.stylesheet(version)),
    )
    return css === null ? plainNotFound() : lookSheetResponse(css, head)
  }

  /** A tree's content host: only what the view handle in the path opens. */
  async function frame(): Promise<Response> {
    if (host?.kind !== 'content') return frameFailure(404)
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return frameFailure(404)
    }
    const treeId = host.treeId
    const path = framePathOf(url.pathname)
    const ref = path === null ? null : treeRefOf(treeId, path.linkPath)
    if (path === null || ref === null) return frameFailure(404)
    try {
      const who = await run(
        runtime,
        frameCallerFor(request, path.handle, treeId),
      )
      if (who === null) return frameFailure(404)
      const served = await runAs(
        who,
        Effect.flatMap(Pages, (pages) =>
          pages.frame({
            treeId,
            seq: path.seq,
            path: ref.path,
            folder: ref.folder,
            range: request.headers.get('range'),
            ifNoneMatch: request.headers.get('if-none-match'),
            host: url.host,
            // `<dossier-copy>` asks its own frame URL for the agent version.
            wantsAgent: acceptsMarkdown(request.headers.get('accept')),
          }),
        ),
      )
      if (isDossierError(served)) {
        return frameFailure(served.code === 'unavailable' ? 503 : 404)
      }
      return frameResponse(served)
    } catch (error) {
      console.error('A frame request failed', { requestId, error })
      return frameFailure(503)
    }
  }

  /** Runs an effect as `who`; a typed failure comes back as the value. */
  async function runAs<A, E extends DossierError>(
    who: Caller,
    effect: Effect.Effect<A, E, CoreServices | CurrentCaller | Background>,
  ): Promise<A | E> {
    const exit = await runtime.runPromiseExit(
      effect.pipe(
        Effect.provideService(CurrentCaller, who),
        Effect.provideService(Background, background),
      ),
    )
    if (Exit.isSuccess(exit)) return exit.value
    const failure = Cause.failureOption(exit.cause)
    if (Option.isSome(failure)) return failure.value
    throw Cause.squash(exit.cause)
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
  ctx: ExecutionContext,
): Promise<Response> => serve(request, env, runtimeFor(env), backgroundFor(ctx))
