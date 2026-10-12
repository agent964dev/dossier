// The fields of each form on a page, read from the parsed tree: which
// controls belong to which form (by nesting, or by a `form` attribute naming
// the form's id, as browsers decide), merged by name into one rule each.

import type { FieldRule, FieldType } from './forms.ts'
import {
  type Element,
  type Node,
  type ParentNode,
  HTML_NS,
  isElement,
  isTemplate,
} from './parse.ts'

/** What a form says about itself and its fields. */
export interface FormFields {
  readonly title: string | null
  readonly fields: readonly FieldRule[]
}

type Option = FieldRule['options'][number]

/** One tree: the document, or the content of one <template>. */
interface Scope {
  readonly forms: Element[]
  readonly controls: Element[]
  readonly labels: Element[]
  readonly ids: Map<string, Element>
}

const CONTROLS: ReadonlySet<string> = new Set([
  'input',
  'select',
  'textarea',
  'button',
])

const INPUT_TYPES: ReadonlySet<string> = new Set([
  'email',
  'url',
  'tel',
  'search',
  'color',
  'hidden',
  'number',
  'range',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
  'file',
  'radio',
  'checkbox',
])

const attrOf = (element: Element, name: string): string | null => {
  for (const attr of element.attrs) {
    if (attr.name === name && !attr.prefix) return attr.value
  }
  return null
}

const hasAttr = (element: Element, name: string): boolean =>
  attrOf(element, name) !== null

const isHtml = (element: Element, name: string): boolean =>
  element.namespaceURI === HTML_NS && element.tagName === name

/** Trimmed, with each run of whitespace one space. */
const collapse = (text: string): string =>
  text.replace(/[\t\n\f\r ]+/g, ' ').trim()

/** An element's text, without the text of `skip` when it sits inside. */
const textOf = (element: Element, skip: Element | null = null): string => {
  let text = ''
  const walk = (node: Node): void => {
    if (node === skip) return
    if (node.nodeName === '#text' && 'value' in node) text += node.value
    else if (isElement(node)) for (const child of node.childNodes) walk(child)
  }
  walk(element)
  return collapse(text)
}

const nonEmpty = (text: string | null): string | null =>
  text === null || text === '' ? null : text

/** The first element below `root` in tree order that `match` accepts. */
const findBelow = (
  root: Element,
  match: (element: Element) => boolean,
): Element | null => {
  for (const node of root.childNodes) {
    if (!isElement(node)) continue
    if (match(node)) return node
    const found = findBelow(node, match)
    if (found !== null) return found
  }
  return null
}

const ancestors = function* (node: Element): Generator<Element> {
  let at: ParentNode | null = node.parentNode
  while (at !== null && 'tagName' in at) {
    yield at
    at = at.parentNode
  }
}

/**
 * A control the browser treats as disabled: its own attribute, or a
 * disabled fieldset around it, unless it sits in that fieldset's first
 * legend. It sends nothing, so it is never required.
 */
const isDisabled = (control: Element): boolean => {
  if (hasAttr(control, 'disabled')) return true
  let below: Element = control
  for (const element of ancestors(control)) {
    if (isHtml(element, 'fieldset') && hasAttr(element, 'disabled')) {
      const legend = element.childNodes.find(
        (node): node is Element => isElement(node) && isHtml(node, 'legend'),
      )
      if (legend !== below) return true
    }
    below = element
  }
  return false
}

const legendOf = (fieldset: Element): string | null => {
  for (const node of fieldset.childNodes) {
    if (isElement(node) && isHtml(node, 'legend')) return nonEmpty(textOf(node))
  }
  return null
}

/**
 * What a control is: its field type before checkboxes of one name are
 * counted, or null for controls that never send a value of their own.
 */
const kindOf = (control: Element): FieldType | null => {
  switch (control.tagName) {
    case 'select':
      return hasAttr(control, 'multiple') ? 'select-multiple' : 'select'
    case 'textarea':
      return 'textarea'
    case 'button': {
      const type = (attrOf(control, 'type') ?? '').trim().toLowerCase()
      return type === 'reset' || type === 'button' ? null : 'submit'
    }
    default: {
      const type = (attrOf(control, 'type') ?? '').trim().toLowerCase()
      if (type === 'submit' || type === 'image') return 'submit'
      if (type === 'reset' || type === 'button') return null
      return INPUT_TYPES.has(type) ? (type as FieldType) : 'text'
    }
  }
}

const integerOf = (value: string | null): number | null => {
  const text = value?.trim() ?? ''
  return /^\d+$/.test(text) ? Number(text) : null
}

/** Every tree of the document: the document itself, then each template's. */
const scopesOf = (root: ParentNode): Scope[] => {
  const scopes: Scope[] = []
  const collect = (top: ParentNode): void => {
    const scope: Scope = { forms: [], controls: [], labels: [], ids: new Map() }
    scopes.push(scope)
    const nested: ParentNode[] = []
    const walk = (nodes: readonly Node[]): void => {
      for (const node of nodes) {
        if (!isElement(node)) continue
        const id = attrOf(node, 'id')
        if (id !== null && !scope.ids.has(id)) scope.ids.set(id, node)
        if (node.namespaceURI === HTML_NS) {
          if (node.tagName === 'form') scope.forms.push(node)
          else if (node.tagName === 'label') scope.labels.push(node)
          else if (CONTROLS.has(node.tagName)) scope.controls.push(node)
        }
        if (isTemplate(node)) nested.push(node.content)
        else walk(node.childNodes)
      }
    }
    walk(top.childNodes)
    for (const content of nested) collect(content)
  }
  collect(root)
  return scopes
}

/** The form a control sends with, as a browser decides it. */
const ownerOf = (control: Element, scope: Scope): Element | null => {
  const named = attrOf(control, 'form')
  if (named !== null) {
    const target = scope.ids.get(named)
    return target !== undefined && isHtml(target, 'form') ? target : null
  }
  for (const element of ancestors(control)) {
    if (isHtml(element, 'form')) return element
  }
  return null
}

const fieldsOf = (
  form: Element,
  controls: readonly Element[],
  scope: Scope,
) => {
  /** A label naming the control, else its aria-label. */
  const labelOf = (control: Element): string | null => {
    const id = attrOf(control, 'id')
    if (id !== null && id !== '' && scope.ids.get(id) === control) {
      for (const label of scope.labels) {
        if (attrOf(label, 'for') !== id) continue
        const text = nonEmpty(textOf(label, control))
        if (text !== null) return text
      }
    }
    for (const element of ancestors(control)) {
      if (!isHtml(element, 'label')) continue
      const target = attrOf(element, 'for')
      if (target === null || target === id) {
        const text = nonEmpty(textOf(element, control))
        if (text !== null) return text
      }
      break
    }
    return nonEmpty(collapse(attrOf(control, 'aria-label') ?? ''))
  }

  const groupLabel = (control: Element): string | null => {
    for (const element of ancestors(control)) {
      if (isHtml(element, 'fieldset')) {
        const legend = legendOf(element)
        if (legend !== null) return legend
        break
      }
    }
    return labelOf(control)
  }

  const groups = new Map<string, Element[]>()
  for (const control of controls) {
    const name = attrOf(control, 'name')
    if (name === null || name === '' || kindOf(control) === null) continue
    const group = groups.get(name)
    if (group === undefined) groups.set(name, [control])
    else group.push(control)
  }

  const fields: FieldRule[] = []
  for (const [name, group] of groups) {
    const first = group[0]!
    const kinds = group.map(kindOf)
    let type = kinds[0]!
    if (type === 'checkbox') {
      const boxes = kinds.filter((kind) => kind === 'checkbox').length
      if (boxes > 1) type = 'checkboxes'
    }

    const options: Option[] = []
    const offer = (value: string, label: string): void => {
      if (!options.some((option) => option.value === value)) {
        options.push({ value, label })
      }
    }
    group.forEach((control, index) => {
      const kind = kinds[index]
      if (type === 'radio' || type === 'checkboxes') {
        if (kind !== 'radio' && kind !== 'checkbox') return
        const value = attrOf(control, 'value') ?? 'on'
        offer(value, labelOf(control) ?? value)
      } else if (type === 'submit') {
        if (kind !== 'submit') return
        const value = attrOf(control, 'value') ?? ''
        // A button shows its text, an image button its alt text.
        const own =
          labelOf(control) ??
          (control.tagName === 'button'
            ? nonEmpty(textOf(control))
            : nonEmpty(collapse(attrOf(control, 'alt') ?? '')))
        offer(value, own ?? value)
      } else if (type === 'select' || type === 'select-multiple') {
        if (kind !== 'select' && kind !== 'select-multiple') return
        // Disabled options cannot be chosen, and a required single
        // select's empty first option is its placeholder, not a choice.
        const placeholder =
          kind === 'select' && hasAttr(control, 'required')
            ? control.childNodes.find(
                (node): node is Element =>
                  isElement(node) && isHtml(node, 'option'),
              )
            : undefined
        const walk = (parent: Element): void => {
          for (const node of parent.childNodes) {
            if (!isElement(node)) continue
            if (isHtml(node, 'option')) {
              if (hasAttr(node, 'disabled')) continue
              if (node === placeholder && attrOf(node, 'value') === '') continue
              const text = textOf(node)
              offer(attrOf(node, 'value') ?? text, text)
            } else if (
              !(isHtml(node, 'optgroup') && hasAttr(node, 'disabled'))
            ) {
              walk(node)
            }
          }
        }
        walk(control)
      }
    })

    const multiple =
      type === 'select-multiple' ||
      ((type === 'file' || type === 'email') && hasAttr(first, 'multiple'))
    fields.push({
      name,
      type,
      label:
        type === 'radio' || type === 'checkboxes'
          ? groupLabel(first)
          : labelOf(first),
      required: group.some(
        (control) => hasAttr(control, 'required') && !isDisabled(control),
      ),
      min: attrOf(first, 'min'),
      max: attrOf(first, 'max'),
      step: attrOf(first, 'step'),
      minLength: integerOf(attrOf(first, 'minlength')),
      maxLength: integerOf(attrOf(first, 'maxlength')),
      pattern: attrOf(first, 'pattern'),
      accept: attrOf(first, 'accept'),
      multiple,
      options,
    })
  }

  const fieldset = findBelow(form, (element) => isHtml(element, 'fieldset'))
  const title =
    (fieldset === null ? null : legendOf(fieldset)) ??
    nonEmpty(collapse(attrOf(form, 'aria-label') ?? ''))
  return { title, fields }
}

/** Each form of the document, its templates' too, with its fields. */
export const formFields = (root: ParentNode): Map<Element, FormFields> => {
  const found = new Map<Element, FormFields>()
  for (const scope of scopesOf(root)) {
    const owned = new Map<Element, Element[]>(
      scope.forms.map((form) => [form, []]),
    )
    for (const control of scope.controls) {
      const owner = ownerOf(control, scope)
      if (owner !== null) owned.get(owner)?.push(control)
    }
    for (const [form, controls] of owned) {
      found.set(form, fieldsOf(form, controls, scope))
    }
  }
  return found
}
