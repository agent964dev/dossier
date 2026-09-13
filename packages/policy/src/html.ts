import * as parse5 from 'parse5'
import type { DefaultTreeAdapterTypes } from 'parse5'

import {
  validateCss,
  validateCssDeclarations,
  validateCssDeclarationsStatic,
  validateCssStatic,
} from './css'
import type { CssPolicyOptions } from './css'
import type { PolicyResult } from './schema'

export interface HtmlPolicyOptions extends CssPolicyOptions {
  maxBytes: number
  embedHostAllowlist: string[]
  scriptHostAllowlist: string[]
}

export interface StaticHtmlPolicyOptions {
  publicOrigin?: string
}

const STATIC_PUBLIC_ORIGIN = 'https://dossier.invalid'
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

type HtmlNode = DefaultTreeAdapterTypes.Node
type HtmlElement = DefaultTreeAdapterTypes.Element

const BLOCKED_TAGS = new Set(['form', 'object', 'embed', 'applet', 'base'])
const URL_ATTRS = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'poster',
  'srcdoc',
  'xlink:href',
])
const BLOCKED_PROTOCOLS = ['javascript:', 'vbscript:', 'file:'] as const
const ALLOWED_SCRIPT_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
])
const MAX_DEPTH = 512
const DOCUMENT_PATH = /^\/d\/[a-z0-9]{12}$/
const STYLESHEET_PATH = /^\/a\/[a-z0-9][a-z0-9-]{0,63}(?:@[1-9][0-9]*)?\.css$/

export function validateHtml(
  html: string,
  options: HtmlPolicyOptions,
): PolicyResult {
  return validateHtmlWithMode(html, options, true)
}

export function validateHtmlStatic(
  html: string,
  options: StaticHtmlPolicyOptions = {},
): PolicyResult {
  return validateHtmlWithMode(
    html,
    {
      maxBytes: Number.MAX_SAFE_INTEGER,
      publicOrigin: options.publicOrigin ?? STATIC_PUBLIC_ORIGIN,
      styleHostAllowlist: [],
      embedHostAllowlist: [],
      scriptHostAllowlist: [],
    },
    false,
  )
}

function validateHtmlWithMode(
  html: string,
  options: HtmlPolicyOptions,
  enforceServerConfig: boolean,
): PolicyResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (typeof html !== 'string' || html.trim() === '') {
    errors.push('HTML document is empty.')
    return emptyResult(errors, warnings)
  }

  const byteLength = new TextEncoder().encode(html).byteLength
  if (enforceServerConfig && byteLength > options.maxBytes) {
    errors.push(
      `HTML document is ${byteLength} bytes; maximum is ${options.maxBytes} bytes.`,
    )
    return emptyResult(errors, warnings)
  }

  if (containsLoneSurrogate(html)) {
    errors.push('HTML document contains a lone surrogate code unit.')
  }

  const documents: DefaultTreeAdapterTypes.Document[] = []
  try {
    // Both interpretations are authoritative. A browser parses <noscript>
    // differently depending on whether scripting is enabled, and validating
    // only one tree creates parser-differential bypasses.
    documents.push(parse5.parse(html, { scriptingEnabled: false }))
    documents.push(parse5.parse(html, { scriptingEnabled: true }))
  } catch {
    errors.push('HTML document could not be parsed.')
    return emptyResult(errors, warnings)
  }

  let title: string | null = null
  let hasInlineScript = false
  let tooDeep = false
  const externalImageHosts = new Set<string>()
  const stylesheetRefs = new Set<string>()
  const embedHosts = new Set<string>()

  const stack: Array<{ node: HtmlNode; elementDepth: number }> = documents
    .map((document) => ({ node: document as HtmlNode, elementDepth: 0 }))
    .reverse()

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break

    const { node, elementDepth } = current
    if (isElement(node)) {
      const tagName = node.tagName.toLowerCase()
      if (elementDepth > MAX_DEPTH) tooDeep = true

      if (BLOCKED_TAGS.has(tagName)) {
        errors.push(`Blocked <${tagName}> tag found.`)
      }

      const attributes = attributesOf(node)

      if (tagName === 'iframe') {
        const src = attributes.get('src') ?? ''
        const host = externalHost(src)
        if (host) embedHosts.add(host)
        if (!isAllowedIframeSource(src, options, enforceServerConfig)) {
          errors.push('Blocked <iframe> tag with a disallowed source.')
        }
      }

      if (tagName === 'link') {
        const href = attributes.get('href') ?? ''
        if (href) stylesheetRefs.add(href)
        const linkError = stylesheetLinkError(
          attributes,
          options,
          enforceServerConfig,
        )
        if (linkError) errors.push(linkError)
      }

      if (tagName === 'script') {
        const isSvgScript = node.namespaceURI === SVG_NAMESPACE
        const svgSourceAttributes = ['src', 'href', 'xlink:href'].filter(
          (name) => attributes.has(name),
        )
        const hasHtmlSource = !isSvgScript && attributes.has('src')

        if (isSvgScript && svgSourceAttributes.length > 0) {
          errors.push('Externally sourced SVG scripts are not allowed.')
        } else if (hasHtmlSource) {
          const src = attributes.get('src') ?? ''
          if (!isAllowedExternalScript(src, options, enforceServerConfig)) {
            errors.push('External script source is not allowlisted.')
          }

          const integrity = (attributes.get('integrity') ?? '').trim()
          if (integrity === '') {
            errors.push(
              'External script sources require an integrity attribute.',
            )
          } else if (!hasUsableIntegrityMetadata(integrity)) {
            errors.push(
              'External script sources require valid SHA-256, SHA-384, or SHA-512 integrity metadata.',
            )
          }
        } else {
          hasInlineScript = true
        }

        const scriptType = (attributes.get('type') ?? '').trim().toLowerCase()
        if (!ALLOWED_SCRIPT_TYPES.has(scriptType)) {
          errors.push(`Unsupported script type "${scriptType}" found.`)
        }
      }

      for (const attribute of node.attrs) {
        const name = qualifiedAttributeName(attribute)
        const value = String(attribute.value ?? '').trim()

        if (name.startsWith('on')) {
          errors.push(`Blocked inline event handler attribute "${name}" found.`)
        }

        if (name === 'srcdoc') {
          errors.push('Blocked "srcdoc" attribute found.')
        }

        if (URL_ATTRS.has(name)) {
          const normalized = normalizeHtmlUrl(value)
          if (
            BLOCKED_PROTOCOLS.some((protocol) =>
              normalized.startsWith(protocol),
            )
          ) {
            errors.push(`Blocked unsafe URL in "${name}" attribute.`)
          }
        }

        if (name === 'style') {
          const cssResult = enforceServerConfig
            ? validateCssDeclarations(value, options)
            : validateCssDeclarationsStatic(value, {
                publicOrigin: options.publicOrigin,
              })
          if (!cssResult.ok) errors.push('Blocked unsafe inline CSS.')
        }
      }

      if (tagName === 'style') {
        const cssResult = enforceServerConfig
          ? validateCss(collectText(node), options)
          : validateCssStatic(collectText(node), {
              publicOrigin: options.publicOrigin,
            })
        if (!cssResult.ok) errors.push('Blocked unsafe CSS in <style> tag.')
      }

      if (tagName === 'meta') {
        const httpEquiv = attributes.get('http-equiv')
        if (httpEquiv?.trim().toLowerCase() === 'refresh') {
          errors.push('Blocked meta refresh tag found.')
        }
      }

      if (tagName === 'img') {
        const host = externalHost(attributes.get('src'))
        if (host) externalImageHosts.add(host)
      }

      if (tagName === 'title' && !title) {
        title = collectText(node).trim().slice(0, 140) || null
      }
    }

    const children = childNodesOf(node)
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (!child) continue
      stack.push({
        node: child,
        elementDepth: elementDepth + (isElement(child) ? 1 : 0),
      })
    }
  }

  if (tooDeep) {
    errors.push(`HTML is nested more than ${MAX_DEPTH} levels deep.`)
  }

  if (!title) {
    warnings.push('No <title> found; Dossier will use a generic title.')
  }

  const uniqueErrors = [...new Set(errors)]
  return {
    ok: uniqueErrors.length === 0,
    errors: uniqueErrors,
    warnings: [...new Set(warnings)],
    title,
    stats: {
      hasInlineScript,
      externalImageHosts: [...externalImageHosts].sort(),
      stylesheetRefs: [...stylesheetRefs].sort(),
      embedHosts: [...embedHosts].sort(),
    },
  }
}

function emptyResult(errors: string[], warnings: string[]): PolicyResult {
  return {
    ok: false,
    errors,
    warnings,
    title: null,
    stats: {
      hasInlineScript: false,
      externalImageHosts: [],
      stylesheetRefs: [],
      embedHosts: [],
    },
  }
}

function isAllowedIframeSource(
  src: string,
  options: HtmlPolicyOptions,
  enforceHostAllowlist: boolean,
): boolean {
  const resolved = resolveUrl(src, options.publicOrigin)
  const publicUrl = resolveUrl(options.publicOrigin, options.publicOrigin)
  if (!resolved || !publicUrl) return false

  if (resolved.origin === publicUrl.origin) {
    return DOCUMENT_PATH.test(resolved.pathname)
  }

  return (
    resolved.protocol === 'https:' &&
    hasDefaultHttpsPort(resolved) &&
    (!enforceHostAllowlist ||
      hostIsAllowed(resolved.hostname, options.embedHostAllowlist))
  )
}

function stylesheetLinkError(
  attributes: Map<string, string>,
  options: HtmlPolicyOptions,
  enforceHostAllowlist: boolean,
): string | null {
  const rel = (attributes.get('rel') ?? '').trim().toLowerCase()
  if (rel !== 'stylesheet') {
    return `Blocked <link rel=${renderAttributeValue(rel)}>; only rel="stylesheet" is allowed.`
  }

  const href = attributes.get('href') ?? ''
  const renderedHref = renderAttributeValue(href)
  const resolved = resolveUrl(href, options.publicOrigin)
  const publicUrl = resolveUrl(options.publicOrigin, options.publicOrigin)
  if (!resolved || !publicUrl) {
    return `Blocked stylesheet <link href=${renderedHref}>; href must be /a/<slug>.css, /a/<slug>@<n>.css, or an allowlisted HTTPS URL.`
  }

  if (resolved.origin === publicUrl.origin) {
    return STYLESHEET_PATH.test(resolved.pathname)
      ? null
      : `Blocked stylesheet <link href=${renderedHref}>; first-party stylesheets must be /a/<slug>.css or /a/<slug>@<n>.css.`
  }

  if (resolved.protocol !== 'https:' || !hasDefaultHttpsPort(resolved)) {
    return `Blocked stylesheet <link href=${renderedHref}>; external stylesheets must use HTTPS on the default port.`
  }

  if (
    enforceHostAllowlist &&
    !hostIsAllowed(resolved.hostname, options.styleHostAllowlist)
  ) {
    return `Blocked stylesheet <link href=${renderedHref}>; host is not in STYLE_HOST_ALLOWLIST.`
  }

  return null
}

function renderAttributeValue(value: string): string {
  const normalized = value.replace(/[\r\n]+/gu, ' ').trim()
  const abbreviated =
    normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized
  return JSON.stringify(abbreviated)
}

function isAllowedExternalScript(
  src: string,
  options: HtmlPolicyOptions,
  enforceHostAllowlist: boolean,
): boolean {
  const resolved = resolveUrl(src, options.publicOrigin)
  if (!resolved) return false

  return (
    resolved.protocol === 'https:' &&
    hasDefaultHttpsPort(resolved) &&
    (!enforceHostAllowlist ||
      hostIsAllowed(resolved.hostname, options.scriptHostAllowlist))
  )
}

const INTEGRITY_DIGEST_BYTES = {
  sha256: 32,
  sha384: 48,
  sha512: 64,
} as const

function hasUsableIntegrityMetadata(value: string): boolean {
  return value.split(/\s+/u).some((token) => {
    const metadata = token.split('?', 1)[0] ?? ''
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/u.exec(
      metadata,
    )
    if (!match) return false

    const algorithm = match[1] as keyof typeof INTEGRITY_DIGEST_BYTES
    const encodedDigest = match[2] ?? ''
    const expectedBytes = INTEGRITY_DIGEST_BYTES[algorithm]
    const expectedEncodedLength = Math.ceil(expectedBytes / 3) * 4
    if (encodedDigest.length !== expectedEncodedLength) return false

    try {
      const decoded = atob(encodedDigest)
      return decoded.length === expectedBytes && btoa(decoded) === encodedDigest
    } catch {
      return false
    }
  })
}

function attributesOf(element: HtmlElement): Map<string, string> {
  return new Map(
    element.attrs.map((attribute) => [
      qualifiedAttributeName(attribute),
      String(attribute.value ?? '').trim(),
    ]),
  )
}

function qualifiedAttributeName(
  attribute: HtmlElement['attrs'][number],
): string {
  const name = attribute.name.toLowerCase()
  return attribute.prefix ? `${attribute.prefix.toLowerCase()}:${name}` : name
}

function isElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node
}

function childNodesOf(node: HtmlNode): HtmlNode[] {
  const children = 'childNodes' in node ? [...node.childNodes] : []
  if (
    isElement(node) &&
    node.tagName.toLowerCase() === 'template' &&
    'content' in node
  ) {
    children.push(...node.content.childNodes)
  }
  return children
}

function collectText(root: HtmlNode): string {
  let value = ''
  const stack: HtmlNode[] = [...childNodesOf(root)].reverse()
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) break
    if (node.nodeName === '#text' && 'value' in node) value += node.value
    const children = childNodesOf(node)
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (child) stack.push(child)
    }
  }
  return value
}

function externalHost(value: string | undefined): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const candidate = raw.startsWith('//') ? `https:${raw}` : raw
  try {
    const url = new URL(candidate)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return normalizeHostname(url.hostname)
    }
  } catch {
    // Relative paths, data URIs, and malformed values are not external hosts.
  }
  return null
}

function resolveUrl(value: string, publicOrigin: string): URL | null {
  if (!value.trim()) return null
  try {
    return new URL(value, new URL(publicOrigin))
  } catch {
    return null
  }
}

function normalizeHtmlUrl(value: string): string {
  let normalized = ''
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (
      codePoint <= 0x20 ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      /\s/u.test(character)
    ) {
      continue
    }
    normalized += character
  }
  return normalized.toLowerCase()
}

function hostIsAllowed(hostname: string, allowlist: string[]): boolean {
  const normalizedHost = normalizeHostname(hostname)
  return allowlist.some((entry) => normalizeHostname(entry) === normalizedHost)
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '')
}

function hasDefaultHttpsPort(url: URL): boolean {
  return url.port === '' || url.port === '443'
}

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true
    }
  }
  return false
}
