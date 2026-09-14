import { Schema } from 'effect'
import * as parse5 from 'parse5'
import type { DefaultTreeAdapterTypes } from 'parse5'

export const FieldType = Schema.Literal(
  'text',
  'textarea',
  'number',
  'date',
  'checkbox',
  'radio',
  'select',
  'select-multiple',
  'json',
)
export type FieldType = typeof FieldType.Type

export const StateField = Schema.Struct({
  name: Schema.String,
  type: FieldType,
  default: Schema.Unknown,
})
export type StateField = typeof StateField.Type

export const StateScan = Schema.Struct({
  ok: Schema.Boolean,
  errors: Schema.Array(Schema.String),
  fields: Schema.Array(StateField),
})
export type StateScan = typeof StateScan.Type

type HtmlNode = DefaultTreeAdapterTypes.Node
type HtmlElement = DefaultTreeAdapterTypes.Element

type MutableStateField = {
  name: string
  type: FieldType
  default: unknown
}

interface FieldDeclaration {
  type: FieldType
  fieldIndex: number | null
  line: number
  column: number
}

interface Position {
  line: number
  column: number
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const STATE_NAME = /^[A-Za-z0-9_.-]{1,64}$/u
const HTML_FLOAT = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/u
const HTML_DATE = /^(\d{4,})-(\d{2})-(\d{2})$/u
const ASCII_WHITESPACE = /[\t\n\f\r ]+/gu
const ASCII_WHITESPACE_EDGES = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu
const INPUT_NEWLINES = /[\n\r]/gu
const UNSUPPORTED_STATE_INPUT_TYPES = new Set([
  'color',
  'datetime-local',
  'email',
  'month',
  'range',
  'time',
  'url',
  'week',
])

export function scanStateFields(html: string): StateScan {
  let document: DefaultTreeAdapterTypes.Document
  try {
    document = parse5.parse(html, {
      scriptingEnabled: true,
      sourceCodeLocationInfo: true,
    })
  } catch {
    return {
      ok: false,
      errors: ['HTML document could not be parsed.'],
      fields: [],
    }
  }

  const errors: string[] = []
  const fields: MutableStateField[] = []
  const declarations = new Map<string, FieldDeclaration>()
  const stack: HtmlNode[] = [...document.childNodes].reverse()

  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) break

    if (isElement(node)) {
      if (node.namespaceURI === SVG_NAMESPACE) continue

      const name = attributeValue(node, 'data-state')
      if (name !== undefined) {
        scanElement(node, name, declarations, fields, errors)
      }
    }

    const children = childNodesOf(node)
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (child) stack.push(child)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    fields,
  }
}

export function statefulHtmlErrors(html: string): string[] {
  const source = html.startsWith('﻿') ? html.slice(1) : html

  try {
    const { document, startTags } = parseWithStartTags(source)
    const errors: string[] = []
    const headTags = startTags.filter((tag) => tag.tagName === 'head')

    if (headTags.length !== 1 || !hasLiteralDocumentHead(document)) {
      errors.push(
        'Stateful HTML must contain exactly one literal <head> start tag.',
      )
    }

    if (
      startTags.some(
        (tag) =>
          tag.tagName === 'meta' &&
          tokenAttributeValue(tag, 'http-equiv')?.trim().toLowerCase() ===
            'content-security-policy',
      )
    ) {
      errors.push(
        'Stateful HTML must not contain a <meta http-equiv="content-security-policy"> tag.',
      )
    }

    if (startTags.some((tag) => tag.tagName === 'plaintext')) {
      errors.push('Stateful HTML must not contain a <plaintext> tag.')
    }

    return errors
  } catch {
    return ['HTML document could not be parsed.']
  }
}

function scanElement(
  element: HtmlElement,
  name: string,
  declarations: Map<string, FieldDeclaration>,
  fields: MutableStateField[],
  errors: string[],
): void {
  const position = elementPosition(element)
  if (!STATE_NAME.test(name)) {
    errors.push(
      `Invalid data-state ${JSON.stringify(name)} at ${renderPosition(position)}; names must match /^[A-Za-z0-9_.-]{1,64}$/.`,
    )
    return
  }

  const unsupportedType = unsupportedInputType(element)
  if (unsupportedType !== null) {
    errors.push(
      `data-state ${JSON.stringify(name)} uses unsupported input type ${JSON.stringify(unsupportedType)} at ${renderPosition(position)}`,
    )
    return
  }

  const type = fieldTypeOf(element)
  const previous = declarations.get(name)
  if (previous) {
    if (previous.type === 'radio' && type === 'radio') {
      if (hasAttribute(element, 'checked') && previous.fieldIndex !== null) {
        const field = fields[previous.fieldIndex]
        if (field) field.default = inputValue(element, 'on')
      }
      return
    }

    errors.push(
      `data-state ${JSON.stringify(name)} is declared twice: ${renderPosition(previous)} and ${renderPosition(position)}`,
    )
    return
  }

  const declaration: FieldDeclaration = {
    type,
    fieldIndex: null,
    ...position,
  }
  declarations.set(name, declaration)

  const defaultResult = defaultForElement(element, type)
  if (!defaultResult.ok) {
    errors.push(
      `data-state ${JSON.stringify(name)} has invalid data-state-default JSON at ${renderPosition(position)}`,
    )
    return
  }

  declaration.fieldIndex = fields.length
  fields.push({ name, type, default: defaultResult.value })
}

function unsupportedInputType(element: HtmlElement): string | null {
  if (element.tagName.toLowerCase() !== 'input') return null
  const type = (attributeValue(element, 'type') ?? '').toLowerCase()
  return UNSUPPORTED_STATE_INPUT_TYPES.has(type) ? type : null
}

function fieldTypeOf(element: HtmlElement): FieldType {
  const tagName = element.tagName.toLowerCase()
  if (tagName === 'input') {
    const inputType = (attributeValue(element, 'type') ?? '').toLowerCase()
    if (inputType === 'radio') return 'radio'
    if (inputType === 'checkbox') return 'checkbox'
    if (inputType === 'number') return 'number'
    if (inputType === 'date') return 'date'
    return 'text'
  }
  if (tagName === 'textarea') return 'textarea'
  if (tagName === 'select') {
    return hasAttribute(element, 'multiple') ? 'select-multiple' : 'select'
  }
  return 'json'
}

type DefaultResult = { ok: true; value: unknown } | { ok: false }

function defaultForElement(
  element: HtmlElement,
  type: FieldType,
): DefaultResult {
  switch (type) {
    case 'text':
      return {
        ok: true,
        value: inputValue(element, '').replace(INPUT_NEWLINES, ''),
      }
    case 'textarea':
      return { ok: true, value: collectText(element) }
    case 'number':
      return { ok: true, value: numberDefault(inputValue(element, '')) }
    case 'date':
      return { ok: true, value: dateDefault(inputValue(element, '')) }
    case 'checkbox':
      return { ok: true, value: hasAttribute(element, 'checked') }
    case 'radio':
      return {
        ok: true,
        value: hasAttribute(element, 'checked')
          ? inputValue(element, 'on')
          : null,
      }
    case 'select':
      return { ok: true, value: selectDefault(element) }
    case 'select-multiple':
      return { ok: true, value: multipleSelectDefault(element) }
    case 'json': {
      const value = attributeValue(element, 'data-state-default') ?? 'null'
      try {
        const parsed: unknown = JSON.parse(value)
        return hasOnlyFiniteNumbers(parsed)
          ? { ok: true, value: parsed }
          : { ok: false }
      } catch {
        return { ok: false }
      }
    }
  }
}

function hasOnlyFiniteNumbers(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(hasOnlyFiniteNumbers)
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).every(hasOnlyFiniteNumbers)
  }
  return true
}

function numberDefault(value: string): number | null {
  if (!HTML_FLOAT.test(value)) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function dateDefault(value: string): string {
  const match = HTML_DATE.exec(value)
  if (!match) return ''

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year === 0 || month < 1 || month > 12) return ''

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day >= 1 && day <= daysInMonth ? value : ''
}

function multipleSelectDefault(element: HtmlElement): string[] {
  return optionElements(element)
    .filter((option) => hasAttribute(option, 'selected'))
    .map(optionValue)
}

function selectDefault(element: HtmlElement): string | null {
  const options = optionElements(element)
  const selected = options.filter((option) => hasAttribute(option, 'selected'))
  const lastSelected = selected.at(-1)
  if (lastSelected) return optionValue(lastSelected)
  if (selectSize(element) > 1) return null

  const firstEnabled = options.find((option) => !optionIsDisabled(option))
  return firstEnabled ? optionValue(firstEnabled) : ''
}

function selectSize(element: HtmlElement): number {
  const value = attributeValue(element, 'size')
  if (value === undefined) return 1
  const match = /^[\t\n\f\r ]*\+?(\d+)/u.exec(value)
  if (!match) return 1

  const size = Number(match[1])
  return Number.isSafeInteger(size) && size > 1 ? size : 1
}

function optionElements(element: HtmlElement): HtmlElement[] {
  const options: HtmlElement[] = []
  const stack: HtmlNode[] = [...element.childNodes].reverse()

  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) break
    if (isElement(node) && node.tagName.toLowerCase() === 'option') {
      options.push(node)
    }

    const children = childNodesOf(node)
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (child) stack.push(child)
    }
  }

  return options
}

function optionIsDisabled(option: HtmlElement): boolean {
  if (hasAttribute(option, 'disabled')) return true

  let parent = option.parentNode
  while (parent && isElement(parent)) {
    if (
      parent.tagName.toLowerCase() === 'optgroup' &&
      hasAttribute(parent, 'disabled')
    ) {
      return true
    }
    if (parent.tagName.toLowerCase() === 'select') break
    parent = parent.parentNode
  }

  return false
}

function optionValue(option: HtmlElement): string {
  const value = attributeValue(option, 'value')
  if (value !== undefined) return value
  return collectText(option)
    .replace(ASCII_WHITESPACE, ' ')
    .replace(ASCII_WHITESPACE_EDGES, '')
}

function inputValue(element: HtmlElement, fallback: string): string {
  return attributeValue(element, 'value') ?? fallback
}

function attributeValue(
  element: HtmlElement,
  name: string,
): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value
}

function hasAttribute(element: HtmlElement, name: string): boolean {
  return element.attrs.some((attribute) => attribute.name === name)
}

function elementPosition(element: HtmlElement): Position {
  const location = element.sourceCodeLocation?.startTag
  return {
    line: location?.startLine ?? 1,
    column: location?.startCol ?? 1,
  }
}

function renderPosition(position: Position): string {
  return `line ${position.line} col ${position.column}`
}

function childNodesOf(node: HtmlNode): HtmlNode[] {
  return 'childNodes' in node ? [...node.childNodes] : []
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

function isElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node
}

type ParserMap = DefaultTreeAdapterTypes.DefaultTreeAdapterMap
type ParserStartTag = Parameters<parse5.Parser<ParserMap>['onStartTag']>[0]

function parseWithStartTags(html: string): {
  document: DefaultTreeAdapterTypes.Document
  startTags: ParserStartTag[]
} {
  const parser = new parse5.Parser<ParserMap>({
    scriptingEnabled: true,
    sourceCodeLocationInfo: true,
  })
  const startTags: ParserStartTag[] = []
  const parseStartTag = parser.onStartTag.bind(parser)
  parser.onStartTag = (tag) => {
    startTags.push(tag)
    parseStartTag(tag)
  }
  parser.tokenizer.write(html, true)
  return { document: parser.document, startTags }
}

function hasLiteralDocumentHead(
  document: DefaultTreeAdapterTypes.Document,
): boolean {
  const htmlElement = document.childNodes.find(
    (node): node is HtmlElement =>
      isElement(node) && node.tagName.toLowerCase() === 'html',
  )
  const headElement = htmlElement?.childNodes.find(
    (node): node is HtmlElement =>
      isElement(node) && node.tagName.toLowerCase() === 'head',
  )
  return headElement?.sourceCodeLocation?.startTag !== undefined
}

function tokenAttributeValue(
  tag: ParserStartTag,
  name: string,
): string | undefined {
  return tag.attrs.find((attribute) => attribute.name === name)?.value
}
