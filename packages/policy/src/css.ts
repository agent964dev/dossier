// css-tree publishes these runtime subpaths without corresponding DefinitelyTyped
// declarations. The focused imports avoid its Node-only definition data loader,
// which keeps the policy bundle compatible with both workerd and a single-file CLI.
// @ts-expect-error css-tree/generator has no published declaration
import generateModule from 'css-tree/generator'
// @ts-expect-error css-tree/parser has no published declaration
import parseModule from 'css-tree/parser'
// @ts-expect-error css-tree/utils has no published declaration
import { ident as identModule } from 'css-tree/utils'
// @ts-expect-error css-tree/walker has no published declaration
import walkModule from 'css-tree/walker'
import type * as CssTree from 'css-tree'

const generate = generateModule as typeof CssTree.generate
const parse = parseModule as typeof CssTree.parse
const ident = identModule as typeof CssTree.ident
const walk = walkModule as typeof CssTree.walk

import type { CssPolicyResult } from './schema'

export interface CssPolicyOptions {
  styleHostAllowlist: string[]
  publicOrigin: string
}

export interface StaticCssPolicyOptions {
  publicOrigin?: string
}

const STATIC_PUBLIC_ORIGIN = 'https://dossier.invalid'

type CssContext = 'stylesheet' | 'declarationList'
type DestinationKind =
  | 'url'
  | 'import'
  | 'image-set'
  | 'custom-property'
  | 'font'

const UNSAFE_CSS_PROTOCOLS = ['javascript:', 'vbscript:', 'file:'] as const

export function validateCss(
  css: string,
  options: CssPolicyOptions,
): CssPolicyResult {
  return validateCssInContext(css, options, 'stylesheet', true)
}

export function validateCssDeclarations(
  css: string,
  options: CssPolicyOptions,
): CssPolicyResult {
  return validateCssInContext(css, options, 'declarationList', true)
}

export function validateCssStatic(
  css: string,
  options: StaticCssPolicyOptions = {},
): CssPolicyResult {
  return validateCssInContext(
    css,
    {
      publicOrigin: options.publicOrigin ?? STATIC_PUBLIC_ORIGIN,
      styleHostAllowlist: [],
    },
    'stylesheet',
    false,
  )
}

export function validateCssDeclarationsStatic(
  css: string,
  options: StaticCssPolicyOptions = {},
): CssPolicyResult {
  return validateCssInContext(
    css,
    {
      publicOrigin: options.publicOrigin ?? STATIC_PUBLIC_ORIGIN,
      styleHostAllowlist: [],
    },
    'declarationList',
    false,
  )
}

function validateCssInContext(
  css: string,
  options: CssPolicyOptions,
  context: CssContext,
  enforceHostAllowlist: boolean,
): CssPolicyResult {
  const errors = new Set<string>()
  const warnings: string[] = []

  const obfuscatedUrlFunction = findObfuscatedUrlFunction(css)
  if (obfuscatedUrlFunction) {
    errors.add(
      `CSS contains an obfuscated URL function. Near "${obfuscatedUrlFunction}".`,
    )
  }

  let ast: CssTree.CssNode
  try {
    ast = parse(css, {
      context,
      parseCustomProperty: true,
    })
  } catch {
    return {
      ok: false,
      errors: ['CSS could not be parsed.'],
      warnings,
    }
  }

  let imageSetDepth = 0

  walk(ast, {
    enter(this: CssTree.WalkContext, node: CssTree.CssNode) {
      if (node.type === 'Declaration') {
        const property = decodeIdentifier(node.property).toLowerCase()
        if (property === 'behavior') {
          errors.add('Blocked unsafe CSS behavior property.')
        }
        if (property === '-moz-binding') {
          errors.add('Blocked unsafe CSS -moz-binding property.')
        }
        return
      }

      if (node.type === 'Function') {
        const functionName = decodeIdentifier(node.name).toLowerCase()
        if (
          functionName === 'image-set' ||
          functionName === '-webkit-image-set'
        ) {
          imageSetDepth += 1
        }
        if (functionName === 'expression') {
          errors.add('Blocked unsafe CSS expression().')
        }

        // css-tree recognises a literal url() as a Url node. An escaped name such
        // as u\\72l() remains a Function, so inspect its argument explicitly.
        if (functionName === 'url') {
          const firstChild = node.children.first
          const value =
            firstChild?.type === 'String'
              ? firstChild.value
              : Array.from(
                  node.children as Iterable<CssTree.CssNode>,
                  (child) => generate(child),
                ).join('')
          checkDestination(
            value,
            destinationKindForContext(this.atrule, this.declaration),
            options,
            errors,
            enforceHostAllowlist,
          )
        }
        return
      }

      if (node.type === 'Url') {
        const atruleName = this.atrule
          ? decodeIdentifier(this.atrule.name).toLowerCase()
          : null
        checkDestination(
          node.value,
          atruleName === 'import'
            ? 'import'
            : destinationKindForContext(this.atrule, this.declaration),
          options,
          errors,
          enforceHostAllowlist,
        )
        return
      }

      if (node.type === 'String') {
        const atruleName = this.atrule
          ? decodeIdentifier(this.atrule.name).toLowerCase()
          : null
        const functionName = this.function
          ? decodeIdentifier(this.function.name).toLowerCase()
          : null
        const declarationName = this.declaration
          ? decodeIdentifier(this.declaration.property)
          : null

        if (atruleName === 'import') {
          checkDestination(
            node.value,
            'import',
            options,
            errors,
            enforceHostAllowlist,
          )
        } else if (imageSetDepth > 0) {
          // Strings nested below var() and other functions still become image
          // candidates when they are inside image-set().
          checkDestination(
            node.value,
            'image-set',
            options,
            errors,
            enforceHostAllowlist,
          )
        } else if (functionName === 'url') {
          checkDestination(
            node.value,
            destinationKindForContext(this.atrule, this.declaration),
            options,
            errors,
            enforceHostAllowlist,
          )
        } else if (
          declarationName?.startsWith('--') &&
          looksLikeDestination(node.value)
        ) {
          checkDestination(
            node.value,
            'custom-property',
            options,
            errors,
            enforceHostAllowlist,
          )
        }
        return
      }

      if (node.type === 'Raw') {
        const normalizedRaw = normalizeRawCss(node.value)
        if (
          normalizedRaw.includes('url(') ||
          normalizedRaw.includes('import')
        ) {
          errors.add('CSS contains an unparsed URL or @import.')
        }
        if (normalizedRaw.includes('expression(')) {
          errors.add('Blocked unsafe CSS expression().')
        }
        if (normalizedRaw.includes('behavior:')) {
          errors.add('Blocked unsafe CSS behavior property.')
        }

        const declarationName = this.declaration
          ? decodeIdentifier(this.declaration.property)
          : null
        const decodedRaw = decodeIdentifier(node.value)
        if (
          declarationName?.startsWith('--') &&
          looksLikeDestination(decodedRaw)
        ) {
          checkDestination(
            decodedRaw,
            'custom-property',
            options,
            errors,
            enforceHostAllowlist,
          )
        }
      }
    },
    leave(node: CssTree.CssNode) {
      if (node.type !== 'Function') return
      const functionName = decodeIdentifier(node.name).toLowerCase()
      if (
        functionName === 'image-set' ||
        functionName === '-webkit-image-set'
      ) {
        imageSetDepth -= 1
      }
    },
  })

  return {
    ok: errors.size === 0,
    errors: [...errors],
    warnings,
  }
}

function checkDestination(
  value: string,
  kind: DestinationKind,
  options: CssPolicyOptions,
  errors: Set<string>,
  enforceHostAllowlist: boolean,
): void {
  const normalized = normalizeUrlForProtocol(value)
  if (
    UNSAFE_CSS_PROTOCOLS.some((protocol) => normalized.startsWith(protocol))
  ) {
    errors.add('Blocked unsafe CSS URL.')
    return
  }

  if (!isAllowedDestination(value, kind, options, enforceHostAllowlist)) {
    const rendered = renderDestination(value)
    switch (kind) {
      case 'import':
        errors.add(
          `CSS @import destination is not allowed. Destination: ${rendered}; use /a/<slug>.css or an HTTPS URL on STYLE_HOST_ALLOWLIST.`,
        )
        break
      case 'image-set':
        errors.add(
          `CSS image-set() destination is not allowed. Destination: ${rendered}; use /a/<slug>.<ext> or an HTTPS URL on STYLE_HOST_ALLOWLIST.`,
        )
        break
      case 'custom-property':
        errors.add(
          `CSS custom-property URL destination is not allowed. Destination: ${rendered}; use /a/<slug>.<ext> or an HTTPS URL on STYLE_HOST_ALLOWLIST.`,
        )
        break
      case 'font':
        errors.add(
          `CSS font destination is not allowed. Destination: ${rendered}; push WOFF2 with dossier assets push and use /a/<slug>.woff2, or use an HTTPS URL on STYLE_HOST_ALLOWLIST.`,
        )
        break
      default:
        errors.add(
          `CSS URL destination is not allowed. Destination: ${rendered}; use /a/<slug>.<ext> or an HTTPS URL on STYLE_HOST_ALLOWLIST.`,
        )
    }
  }
}

function isAllowedDestination(
  value: string,
  kind: DestinationKind,
  options: CssPolicyOptions,
  enforceHostAllowlist: boolean,
): boolean {
  const raw = value.trim()
  if (raw === '') return kind !== 'import'
  if (raw.startsWith('#')) return kind !== 'import'

  let publicUrl: URL
  let destination: URL
  try {
    publicUrl = new URL(options.publicOrigin)
    destination = new URL(raw, publicUrl)
  } catch {
    return false
  }

  if (destination.protocol === 'data:') {
    return kind !== 'import' && kind !== 'font'
  }

  if (destination.protocol !== 'http:' && destination.protocol !== 'https:') {
    return false
  }

  if (destination.origin === publicUrl.origin) {
    return destination.pathname.startsWith('/a/')
  }

  return (
    destination.protocol === 'https:' &&
    hasDefaultHttpsPort(destination) &&
    (!enforceHostAllowlist ||
      hostIsAllowed(destination.hostname, options.styleHostAllowlist))
  )
}

function destinationKindForContext(
  atrule: CssTree.Atrule | null,
  declaration: CssTree.Declaration | null,
): DestinationKind {
  const atruleName = atrule ? decodeIdentifier(atrule.name).toLowerCase() : null
  const declarationName = declaration
    ? decodeIdentifier(declaration.property).toLowerCase()
    : null
  return atruleName === 'font-face' && declarationName === 'src'
    ? 'font'
    : 'url'
}

function looksLikeDestination(value: string): boolean {
  const raw = value.trim()
  return /^(?:\\+|[a-z][a-z0-9+.-]*:|\/\/|\/|\.\.?\/|#)/i.test(raw)
}

function decodeIdentifier(value: string): string {
  try {
    return ident.decode(value)
  } catch {
    return value
  }
}

function findObfuscatedUrlFunction(value: string): string | null {
  const codeOnly = maskCssStringsAndComments(value)
  const match = /(?:u\s+r\s*l|u\s*r\s+l|url\s+)\s*\(/iu.exec(codeOnly)
  return match ? match[0].replace(/\s+/gu, ' ').trim() : null
}

function maskCssStringsAndComments(value: string): string {
  let masked = ''
  let quote: '"' | "'" | null = null
  let inComment = false

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? ''
    const next = value[index + 1] ?? ''

    if (inComment) {
      if (character === '*' && next === '/') {
        masked += '  '
        index += 1
        inComment = false
      } else {
        masked += character === '\n' || character === '\r' ? character : ' '
      }
      continue
    }

    if (quote) {
      if (character === '\\' && next !== '') {
        masked += '  '
        index += 1
      } else {
        masked += character === '\n' || character === '\r' ? character : ' '
        if (character === quote) quote = null
      }
      continue
    }

    if (character === '/' && next === '*') {
      masked += '  '
      index += 1
      inComment = true
    } else if (character === '"' || character === "'") {
      masked += ' '
      quote = character
    } else {
      masked += character
    }
  }

  return masked
}

function renderDestination(value: string): string {
  const trimmed = value.trim()
  const abbreviated =
    trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed
  return JSON.stringify(abbreviated)
}

function normalizeRawCss(value: string): string {
  const withoutComments = value.replace(/\/\*[\s\S]*?\*\//g, '')
  return decodeIdentifier(withoutComments).replace(/\s+/g, '').toLowerCase()
}

function normalizeUrlForProtocol(value: string): string {
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
