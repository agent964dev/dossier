// The URLs a page's own markup loads without naming them in an attribute:
// `url()` and `@import` in CSS, and the static imports of an inline module
// script. Light tokenizers, enough to tell a URL from a comment or a string
// that only looks like one.

import { parseFragment } from 'parse5'

export type InlineRefKind = 'css-url' | 'css-import' | 'module-import'

/** A URL found in a text: its range in that text and the URL it requests. */
export interface FoundRef {
  readonly kind: InlineRefKind
  readonly start: number
  readonly end: number
  readonly url: string
}

/** A text as decoded, with where each of its characters was written. */
export interface Mapped {
  readonly text: string
  /** Per character of `text`, plus one past the end: written offsets. */
  readonly starts: readonly number[]
  readonly ends: readonly number[]
}

/** The written range of `text.slice(start, end)`. */
export const writtenRange = (
  mapped: Mapped,
  start: number,
  end: number,
): { readonly start: number; readonly end: number } => {
  const from = mapped.starts[start] ?? mapped.starts[mapped.text.length] ?? 0
  return {
    start: from,
    end: end > start ? (mapped.ends[end - 1] ?? from) : from,
  }
}

/** Raw text, written as it reads, from `offset` in the source. */
export const unmapped = (text: string, offset: number): Mapped => {
  const starts: number[] = []
  const ends: number[] = []
  for (let index = 0; index <= text.length; index++) {
    starts.push(offset + index)
    ends.push(offset + index + 1)
  }
  return { text, starts, ends }
}

const REFERENCE = /&(?:#[xX][0-9a-fA-F]+;?|#[0-9]+;?|[A-Za-z][A-Za-z0-9]*;?)/g

const decodedReferences = new Map<string, string>()

/** One character reference as parse5 reads it in an attribute or in text. */
const decodeReference = (written: string, inAttribute: boolean): string => {
  const key = `${inAttribute ? 'a' : 't'}${written}`
  const cached = decodedReferences.get(key)
  if (cached !== undefined) return cached
  const fragment = parseFragment(
    inAttribute ? `<i title="${written}"></i>` : `<i>${written}</i>`,
  )
  const element = fragment.childNodes[0]
  let decoded = written
  if (element !== undefined && 'attrs' in element) {
    if (inAttribute) {
      decoded = element.attrs[0]?.value ?? written
    } else {
      const text = element.childNodes[0]
      decoded = text !== undefined && 'value' in text ? text.value : written
    }
  }
  if (decodedReferences.size < 1024) decodedReferences.set(key, decoded)
  return decoded
}

/**
 * Text written in an attribute value or in foreign content, with character
 * references decoded as the parser decodes them, each decoded character
 * mapped to the reference it was written as.
 */
export const decodeCharacterReferences = (
  written: string,
  offset: number,
  inAttribute: boolean,
): Mapped => {
  let text = ''
  const starts: number[] = []
  const ends: number[] = []
  let pos = 0
  const plain = (to: number): void => {
    for (let index = pos; index < to; index++) {
      text += written[index]
      starts.push(offset + index)
      ends.push(offset + index + 1)
    }
  }
  for (const match of written.matchAll(REFERENCE)) {
    plain(match.index)
    const decoded = decodeReference(match[0], inAttribute)
    for (const char of decoded) {
      for (let unit = 0; unit < char.length; unit++) {
        text += char[unit]
        starts.push(offset + match.index)
        ends.push(offset + match.index + match[0].length)
      }
    }
    pos = match.index + match[0].length
  }
  plain(written.length)
  starts.push(offset + written.length)
  ends.push(offset + written.length)
  return { text, starts, ends }
}

// CSS

const isCssSpace = (char: string | undefined): boolean =>
  char === ' ' ||
  char === '\t' ||
  char === '\n' ||
  char === '\r' ||
  char === '\f'

const isNameChar = (char: string | undefined): boolean =>
  char !== undefined &&
  (/[A-Za-z0-9_-]/.test(char) || char.charCodeAt(0) >= 0x80)

/** CSS escapes decoded: `\31 ` is `1`, `\"` is `"`, an escaped newline goes. */
export const decodeCssEscapes = (value: string): string =>
  value.replace(
    /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([\s\S]))/g,
    (_, hex: string | undefined, newline: string | undefined, char = '') => {
      if (newline !== undefined) return ''
      if (hex === undefined) return char
      const code = Number.parseInt(hex, 16)
      return code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff
        ? '�'
        : String.fromCodePoint(code)
    },
  )

/** How long the CSS escape at `at` is: a hex escape takes one space after. */
const escapeLength = (text: string, at: number): number => {
  const hex = /^[0-9a-fA-F]{1,6}(?:\r\n|[ \t\n\r\f])?/.exec(
    text.slice(at + 1, at + 9),
  )
  return 1 + (hex === null ? 1 : hex[0].length)
}

interface Span {
  readonly start: number
  readonly end: number
  /** Where reading continues. */
  readonly next: number
}

/** A CSS string starting at its quote; null when a newline breaks it. */
const cssString = (text: string, at: number): Span | null => {
  const quote = text[at]
  let pos = at + 1
  while (pos < text.length) {
    const char = text[pos]
    if (char === quote) return { start: at + 1, end: pos, next: pos + 1 }
    if (char === '\n' || char === '\r' || char === '\f') return null
    pos += char === '\\' ? 2 : 1
  }
  return { start: at + 1, end: text.length, next: text.length }
}

/** Where a broken CSS string or `url(` stops being read. */
const skipBroken = (text: string, at: number, stop: string): number => {
  let pos = at
  while (pos < text.length && !stop.includes(text[pos] ?? '')) {
    pos += text[pos] === '\\' ? 2 : 1
  }
  return pos + 1
}

const skipCssSpace = (text: string, at: number): number => {
  let pos = at
  for (;;) {
    while (isCssSpace(text[pos])) pos++
    if (text.startsWith('/*', pos)) {
      const close = text.indexOf('*/', pos + 2)
      pos = close < 0 ? text.length : close + 2
    } else return pos
  }
}

/**
 * The URL of a `url(` whose `(` ends before `at`: quoted or not. Null for a
 * URL the browser drops as malformed.
 */
const cssUrl = (text: string, at: number): Span | null => {
  let pos = at
  while (isCssSpace(text[pos])) pos++
  if (text[pos] === '"' || text[pos] === "'") {
    const string = cssString(text, pos)
    if (string === null) return null
    let after = string.next
    while (isCssSpace(text[after])) after++
    return { ...string, next: text[after] === ')' ? after + 1 : after }
  }
  const start = pos
  while (pos < text.length) {
    const char = text[pos] ?? ''
    if (char === ')') return { start, end: pos, next: pos + 1 }
    if (isCssSpace(char)) {
      const end = pos
      while (isCssSpace(text[pos])) pos++
      if (pos >= text.length || text[pos] === ')') {
        return { start, end, next: pos + 1 }
      }
      return null
    }
    const code = char.charCodeAt(0)
    if (
      char === '"' ||
      char === "'" ||
      char === '(' ||
      code <= 0x08 ||
      code === 0x0b ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      return null
    }
    if (char === '\\') {
      const next = text[pos + 1]
      if (next === '\n' || next === '\r' || next === '\f') return null
      pos += escapeLength(text, pos)
    } else pos++
  }
  return { start, end: text.length, next: text.length }
}

const IMAGE_SETS: ReadonlySet<string> = new Set([
  'image-set',
  '-webkit-image-set',
])

/**
 * Every `url()` and `@import` in a style sheet or a style attribute: `url()`
 * quoted or not, the strings of an `image-set()`, and the string or `url()`
 * an `@import` names. Nothing inside a comment counts, nor a string that is
 * none of these.
 */
export const cssRefs = (text: string): FoundRef[] => {
  const found: FoundRef[] = []
  const add = (kind: InlineRefKind, span: Span): void => {
    found.push({
      kind,
      start: span.start,
      end: span.end,
      url: decodeCssEscapes(text.slice(span.start, span.end)),
    })
  }
  // The paren depths at which an image-set's strings name images.
  const imageSets: number[] = []
  let depth = 0
  let pos = 0
  while (pos < text.length) {
    const char = text[pos]
    if (char === '/' && text[pos + 1] === '*') {
      const close = text.indexOf('*/', pos + 2)
      pos = close < 0 ? text.length : close + 2
    } else if (char === '"' || char === "'") {
      const string = cssString(text, pos)
      if (string === null) {
        pos = skipBroken(text, pos + 1, '\n\r\f')
        continue
      }
      if (imageSets.at(-1) === depth) add('css-url', string)
      pos = string.next
    } else if (char === '\\') {
      pos += 2
    } else if (char === '#') {
      // A hash, such as a colour, is never a function's name.
      pos++
      while (isNameChar(text[pos])) pos++
    } else if (char === '(') {
      depth++
      pos++
    } else if (char === ')') {
      if (imageSets.at(-1) === depth) imageSets.pop()
      depth = Math.max(0, depth - 1)
      pos++
    } else if (char === '@') {
      let end = pos + 1
      while (isNameChar(text[end])) end++
      const name = text.slice(pos + 1, end).toLowerCase()
      pos = end
      if (name !== 'import') continue
      const at = skipCssSpace(text, end)
      if (text[at] === '"' || text[at] === "'") {
        const string = cssString(text, at)
        if (string !== null) {
          add('css-import', string)
          pos = string.next
        }
      } else if (text.slice(at, at + 4).toLowerCase() === 'url(') {
        const url = cssUrl(text, at + 4)
        if (url !== null) add('css-import', url)
        pos = url === null ? skipBroken(text, at + 4, ')') : url.next
      }
    } else if (isNameChar(char)) {
      let end = pos
      while (isNameChar(text[end])) end++
      const name = text.slice(pos, end).toLowerCase()
      pos = end
      if (text[end] !== '(') continue
      if (name === 'url') {
        const url = cssUrl(text, end + 1)
        if (url !== null) add('css-url', url)
        pos = url === null ? skipBroken(text, end + 1, ')') : url.next
      } else {
        depth++
        pos = end + 1
        if (IMAGE_SETS.has(name)) imageSets.push(depth)
      }
    } else {
      pos++
    }
  }
  return found
}

// JavaScript

interface Token {
  readonly kind: 'name' | 'string' | 'punct' | 'other'
  readonly value: string
  readonly start: number
  readonly end: number
}

const isJsNameChar = (char: string | undefined): boolean =>
  char !== undefined &&
  (/[A-Za-z0-9_$]/.test(char) || char.charCodeAt(0) >= 0x80)

const isLineBreak = (char: string | undefined): boolean =>
  char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029'

/** Names after which a `/` starts a regular expression, not a division. */
const BEFORE_EXPRESSION: ReadonlySet<string> = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'export',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
])

/** JavaScript string escapes decoded. */
export const decodeJsEscapes = (value: string): string =>
  value.replace(
    /\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|(\r\n|[\n\r\u2028\u2029])|([\s\S]))/g,
    (
      _,
      hex: string | undefined,
      braced: string | undefined,
      unit: string | undefined,
      newline: string | undefined,
      char = '',
    ) => {
      const code = hex ?? braced ?? unit
      if (code !== undefined) {
        const point = Number.parseInt(code, 16)
        return point > 0x10ffff ? '�' : String.fromCodePoint(point)
      }
      if (newline !== undefined) return ''
      const single: Record<string, string> = {
        n: '\n',
        t: '\t',
        r: '\r',
        b: '\b',
        f: '\f',
        v: '\v',
        '0': '\0',
      }
      return single[char] ?? char
    },
  )

/**
 * The tokens of a script that matter for its imports: names, strings and
 * punctuation. Comments, template literals and regular expressions are read
 * past; a template's substitutions are read as code.
 */
const jsTokens = (text: string): Token[] => {
  const tokens: Token[] = []
  // The brace depth each open template substitution closes at.
  const templates: number[] = []
  let braces = 0
  let pos = 0
  const last = (): Token | undefined => tokens.at(-1)
  const startsRegex = (): boolean => {
    const before = last()
    if (before === undefined) return true
    if (before.kind === 'punct')
      return before.value !== ')' && before.value !== ']'
    if (before.kind === 'name') return BEFORE_EXPRESSION.has(before.value)
    return false
  }
  /** Reads a template's text from `at` to its end or its next `${`. */
  const template = (at: number): void => {
    let p = at
    while (p < text.length) {
      const char = text[p]
      if (char === '\\') p += 2
      else if (char === '`') {
        tokens.push({ kind: 'other', value: '`', start: at, end: p + 1 })
        pos = p + 1
        return
      } else if (char === '$' && text[p + 1] === '{') {
        templates.push(++braces)
        tokens.push({ kind: 'punct', value: '${', start: p, end: p + 2 })
        pos = p + 2
        return
      } else p++
    }
    pos = text.length
  }
  while (pos < text.length) {
    const char = text[pos] ?? ''
    if (/\s/.test(char)) {
      pos++
    } else if (char === '/' && text[pos + 1] === '/') {
      while (pos < text.length && !isLineBreak(text[pos])) pos++
    } else if (char === '/' && text[pos + 1] === '*') {
      const close = text.indexOf('*/', pos + 2)
      pos = close < 0 ? text.length : close + 2
    } else if (char === '"' || char === "'") {
      let p = pos + 1
      let closed = false
      while (p < text.length) {
        const c = text[p]
        if (c === char) {
          closed = true
          break
        }
        if (c === '\n' || c === '\r') break
        p += c === '\\' ? 2 : 1
      }
      if (closed) {
        tokens.push({
          kind: 'string',
          value: text.slice(pos + 1, p),
          start: pos + 1,
          end: p,
        })
      } else {
        tokens.push({ kind: 'other', value: '', start: pos, end: p })
      }
      pos = p + 1
    } else if (char === '`') {
      template(pos + 1)
    } else if (char === '/' && startsRegex()) {
      let p = pos + 1
      let inClass = false
      while (p < text.length && !isLineBreak(text[p])) {
        const c = text[p]
        if (c === '\\') p++
        else if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) break
        p++
      }
      p++
      while (isJsNameChar(text[p])) p++
      tokens.push({ kind: 'other', value: '', start: pos, end: p })
      pos = p
    } else if (isJsNameChar(char) || char === '\\') {
      let p = pos
      while (p < text.length && (isJsNameChar(text[p]) || text[p] === '\\')) {
        p += text[p] === '\\' ? 2 : 1
      }
      const value = text.slice(pos, p)
      tokens.push({
        kind: /^[0-9]/.test(value) ? 'other' : 'name',
        value,
        start: pos,
        end: p,
      })
      pos = p
    } else if (char === '}' && templates.at(-1) === braces) {
      templates.pop()
      braces--
      template(pos + 1)
    } else {
      if (char === '{') braces++
      else if (char === '}') braces--
      const value = char === '?' && text[pos + 1] === '.' ? '?.' : char
      tokens.push({ kind: 'punct', value, start: pos, end: pos + value.length })
      pos += value.length
    }
  }
  return tokens
}

/** What may stand between `import` or `export` and its `from`. */
const isClauseToken = (token: Token): boolean =>
  token.kind === 'name' ||
  token.kind === 'string' ||
  (token.kind === 'punct' && ['*', ',', '{', '}'].includes(token.value))

/**
 * The module each static import or re-export of a module script names:
 * `import x from './a.js'`, `import './a.js'`, `export … from './a.js'`.
 * Not `import()`, `import.meta`, a property named import, or a string that
 * only looks like an import.
 */
export const moduleImports = (text: string): FoundRef[] => {
  const tokens = jsTokens(text)
  const found: FoundRef[] = []
  const add = (token: Token): void => {
    found.push({
      kind: 'module-import',
      start: token.start,
      end: token.end,
      url: decodeJsEscapes(token.value),
    })
  }
  tokens.forEach((token, index) => {
    if (token.kind !== 'name') return
    if (token.value !== 'import' && token.value !== 'export') return
    const before = tokens[index - 1]
    if (
      before?.kind === 'punct' &&
      (before.value === '.' || before.value === '?.')
    ) {
      return
    }
    const next = tokens[index + 1]
    if (next === undefined) return
    if (token.value === 'import' && next.kind === 'string') {
      add(next)
      return
    }
    if (
      token.value === 'export' &&
      !(next.kind === 'punct' && (next.value === '*' || next.value === '{'))
    ) {
      return
    }
    for (let at = index + 1; at < tokens.length; at++) {
      const clause = tokens[at]!
      if (!isClauseToken(clause)) return
      const source = tokens[at + 1]
      if (
        clause.kind === 'name' &&
        clause.value === 'from' &&
        source?.kind === 'string'
      ) {
        add(source)
        return
      }
    }
  })
  return found
}
