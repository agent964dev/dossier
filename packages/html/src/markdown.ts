// A page's generated agent version: Markdown from the page as pushed, for a
// page with no companion. parse5 parses the page, hast-util-from-parse5 and
// hast-util-to-mdast turn it into a Markdown tree, and mdast-util-to-markdown
// with GFM writes it. Dossier's own rules come first: SVG titles and
// descriptions, Mermaid source, math, each form's questions without answers,
// and one line naming each part drawn only by script. Layouts are never part
// of it, and the same page always gives the same bytes.
import type {
  Element,
  ElementContent,
  Nodes as HastNodes,
  Root as HastRoot,
} from 'hast'
import { fromParse5 } from 'hast-util-from-parse5'
import { toMdast, type NodeHandle } from 'hast-util-to-mdast'
import type {
  Html,
  List,
  ListItem,
  Nodes as MdastNodes,
  Root as MdastRoot,
  RootContent,
} from 'mdast'
import { gfmToMarkdown } from 'mdast-util-gfm'
import { toMarkdown as writeMarkdown } from 'mdast-util-to-markdown'
import { parse } from 'parse5'

import { isCustomElementName } from './kit.ts'

/** Bumped whenever the generated text changes for the same page. */
export const MARKDOWN_VERSION: number = 3

/** A line Dossier writes as it stands, never escaped. */
interface Line {
  readonly type: 'dossierLine'
  readonly value: string
  /** On lines of its own, rather than inside the text around it. */
  readonly block: boolean
}

type Prop = string | number | boolean | readonly (string | number)[] | null

const prop = (element: Element, name: string): string | null => {
  const value = element.properties[name] as Prop | undefined
  if (value === undefined || value === null || value === false) return null
  if (value === true) return ''
  return Array.isArray(value) ? value.join(' ') : String(value)
}

const classes = (element: Element): readonly string[] => {
  const value = element.properties.className
  return Array.isArray(value) ? value.map(String) : []
}

const isElement = (node: HastNodes): node is Element => node.type === 'element'

/**
 * The text a node holds, with runs of white space as one space, leaving out
 * the subtrees of any element named in `without`.
 */
const textOf = (
  node: HastNodes,
  without: ReadonlySet<string> = SKIPPED,
): string => {
  const parts: string[] = []
  const walk = (at: HastNodes) => {
    if (at.type === 'text') parts.push(at.value)
    else if (at.type === 'element' || at.type === 'root') {
      if (at.type === 'element' && without.has(at.tagName)) return
      for (const child of at.children) walk(child)
    }
  }
  walk(node)
  return parts.join('').replace(/\s+/g, ' ').trim()
}

/**
 * A `hidden` element is not part of the page as people see it, except
 * `hidden="until-found"`, which the browser reveals when someone searches.
 */
const isHidden = (element: Element): boolean => {
  const value = element.properties.hidden
  const hidden =
    value !== undefined &&
    value !== null &&
    value !== false &&
    String(value).trim().toLowerCase() !== 'until-found'
  return hidden || displaysNone(prop(element, 'style'))
}

/**
 * Whether an inline style attribute's last `display` declaration is
 * `none`. Stylesheets are never read: the page's text does not depend on
 * which rules match.
 */
const displaysNone = (style: string | null): boolean => {
  if (style === null) return false
  let none = false
  const code = style.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ')
  for (const declaration of code.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    if (declaration.slice(0, colon).trim().toLowerCase() !== 'display') continue
    none =
      declaration
        .slice(colon + 1)
        .replace(/!\s*important\s*$/i, '')
        .trim()
        .toLowerCase() === 'none'
  }
  return none
}

/**
 * A required single select's placeholder: its first option in tree order,
 * when that option sits directly in the select and has `value=""`, as HTML
 * defines it. Decided on the page as written, before anything is pruned.
 */
const placeholderOf = (select: Element): Element | null => {
  if (prop(select, 'required') === null || prop(select, 'multiple') !== null) {
    return null
  }
  if (Number(prop(select, 'size') ?? '1') > 1) return null
  const first = descendants(select).find(
    ({ element }) => element.tagName === 'option',
  )
  if (first === undefined) return null
  const direct = first.above[first.above.length - 1] === select
  return direct && prop(first.element, 'value') === '' ? first.element : null
}

/** The page without any required select's placeholder option. */
const withoutPlaceholders = (element: Element): Element => {
  const placeholder =
    element.tagName === 'select' ? placeholderOf(element) : null
  return {
    ...element,
    children: element.children.flatMap((child): ElementContent[] =>
      !isElement(child)
        ? [child]
        : child === placeholder
          ? []
          : [withoutPlaceholders(child)],
    ),
  }
}

/**
 * The page without what no reader sees: comments, scripts, styles,
 * templates, noscript and every hidden subtree. Every later rule reads this.
 */
const visible = (element: Element): Element => ({
  ...element,
  children: element.children.flatMap((child): ElementContent[] => {
    if (child.type === 'comment') return []
    if (!isElement(child)) return [child]
    if (SKIPPED.has(child.tagName) || isHidden(child)) return []
    return [visible(child)]
  }),
})

/** The source inside an element as written, for code, Mermaid and TeX. */
const rawTextOf = (node: HastNodes): string => {
  if (node.type === 'text') return node.value
  if (node.type !== 'element' && node.type !== 'root') return ''
  return node.children.map(rawTextOf).join('')
}

/** Never part of the agent version. */
const SKIPPED: ReadonlySet<string> = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'head',
])

const CONTROLS: ReadonlySet<string> = new Set([
  'input',
  'select',
  'textarea',
  'button',
])

/** What a part drawn without text is called in its line. */
const PLACEHOLDER: Readonly<Record<string, string>> = {
  canvas: 'Chart',
  iframe: 'Embed',
  object: 'Embed',
  embed: 'Embed',
}

const nameOf = (element: Element): string | null => {
  const name = prop(element, 'ariaLabel') ?? prop(element, 'title')
  const trimmed = name?.replace(/\s+/g, ' ').trim() ?? ''
  return trimmed === '' ? null : trimmed
}

const line = (value: string, block: boolean): Line => ({
  type: 'dossierLine',
  value,
  block,
})

/** '[SVG: Title. Description.]', from an inline SVG's own title and desc. */
const svgLine = (svg: Element): Line | null => {
  const own = (tag: string) => {
    const child = svg.children.find(
      (node): node is Element => isElement(node) && node.tagName === tag,
    )
    return child === undefined ? '' : textOf(child)
  }
  const parts = [own('title') || nameOf(svg) || '', own('desc')]
    .filter((part) => part !== '')
    .map((part) => (/[.!?]$/.test(part) ? part : `${part}.`))
  return parts.length === 0 ? null : line(`[SVG: ${parts.join(' ')}]`, false)
}

interface Field {
  readonly label: string
  readonly type: string
  readonly required: boolean
  readonly options: readonly string[]
}

const IGNORED_INPUTS: ReadonlySet<string> = new Set([
  'hidden',
  'submit',
  'reset',
  'button',
  'image',
])

/** Each element below `root` with its ancestors, in document order. */
const descendants = (
  root: Element,
): readonly { readonly element: Element; readonly above: Element[] }[] => {
  const found: { element: Element; above: Element[] }[] = []
  const walk = (at: Element, above: Element[]) => {
    for (const child of at.children) {
      if (!isElement(child) || SKIPPED.has(child.tagName)) continue
      found.push({ element: child, above })
      walk(child, [...above, child])
    }
  }
  walk(root, [root])
  return found
}

/** Elements whose contents are values or choices, never a label's words. */
const VALUE_HOLDERS: ReadonlySet<string> = new Set([
  ...SKIPPED,
  'select',
  'textarea',
  'datalist',
  'option',
  'optgroup',
])

/** The text of a label, without the contents of any control inside it. */
const labelText = (label: Element): string => textOf(label, VALUE_HOLDERS)

type Placed = { readonly element: Element; readonly above: Element[] }

/** Where each form's controls are and what the page's labels say. */
interface Forms {
  /** Each form's controls in document order, wherever they sit. */
  readonly controls: ReadonlyMap<Element, readonly Placed[]>
  /** `<label for>` text by the id it names, the first label winning. */
  readonly labelsFor: ReadonlyMap<string, string>
}

const FORM_CONTROLS: ReadonlySet<string> = new Set([
  'input',
  'select',
  'textarea',
])

/**
 * Which form owns each control, as the browser decides: the form its
 * `form` attribute names by id, or none when no form has that id; else the
 * form it sits in.
 */
const formsOf = (root: Element): Forms => {
  const all = descendants(root)
  const byId = new Map<string, Element>()
  const labelsFor = new Map<string, string>()
  for (const { element } of all) {
    const id = element.tagName === 'form' ? prop(element, 'id') : null
    if (id !== null && !byId.has(id)) byId.set(id, element)
    const target = element.tagName === 'label' ? prop(element, 'htmlFor') : null
    if (target !== null && !labelsFor.has(target)) {
      labelsFor.set(target, labelText(element))
    }
  }
  const controls = new Map<Element, Placed[]>()
  for (const placed of all) {
    if (!FORM_CONTROLS.has(placed.element.tagName)) continue
    const named = prop(placed.element, 'form')
    const owner =
      named !== null
        ? byId.get(named)
        : [...placed.above].reverse().find((el) => el.tagName === 'form')
    if (owner === undefined) continue
    const list = controls.get(owner) ?? []
    list.push(placed)
    controls.set(owner, list)
  }
  return { controls, labelsFor }
}

/**
 * The options a person can choose and send: every enabled option with text,
 * an empty value included. A required select's placeholder is already gone
 * (`withoutPlaceholders`), and so are hidden options.
 */
const selectOptions = (select: Element): readonly string[] =>
  descendants(select)
    .filter(({ element }) => element.tagName === 'option')
    .filter(({ element, above }) => {
      if (prop(element, 'disabled') !== null) return false
      return !above.some(
        (el) => el.tagName === 'optgroup' && prop(el, 'disabled') !== null,
      )
    })
    .map(({ element }) => textOf(element))
    .filter((text) => text !== '')

/** A form's questions in order: its labels, types and options, never a value. */
const formFields = (form: Element, forms: Forms): readonly Field[] => {
  const all = forms.controls.get(form) ?? []
  const { labelsFor } = forms
  const labelOf = (control: Element, above: readonly Element[]): string => {
    const id = prop(control, 'id')
    const byFor = id === null ? undefined : labelsFor.get(id)
    if (byFor !== undefined && byFor !== '') return byFor
    const wrapping = [...above].reverse().find((el) => el.tagName === 'label')
    const wrapped = wrapping === undefined ? '' : labelText(wrapping)
    return (
      (wrapped !== '' ? wrapped : null) ??
      nameOf(control) ??
      prop(control, 'placeholder') ??
      prop(control, 'name') ??
      ''
    )
  }
  const questionOf = (above: readonly Element[], name: string): string => {
    const fieldset = [...above]
      .reverse()
      .find((el) => el.tagName === 'fieldset')
    const legend = fieldset?.children.find(
      (child): child is Element =>
        isElement(child) && child.tagName === 'legend',
    )
    const group = [...above]
      .reverse()
      .find((el) => ['radiogroup', 'group'].includes(prop(el, 'role') ?? ''))
    return (
      (legend === undefined ? null : textOf(legend) || null) ??
      (group === undefined ? null : nameOf(group)) ??
      name
    )
  }

  const fields: (Field & { options: string[]; required: boolean })[] = []
  const groups = new Map<string, Field & { options: string[] }>()
  const counts = new Map<string, number>()
  for (const { element } of all) {
    if (element.tagName !== 'input') continue
    const type = (prop(element, 'type') ?? 'text').toLowerCase()
    const name = prop(element, 'name')
    if ((type === 'radio' || type === 'checkbox') && name !== null) {
      const key = `${type}:${name}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  for (const { element, above } of all) {
    const required = prop(element, 'required') !== null
    switch (element.tagName) {
      case 'input': {
        const type = (prop(element, 'type') ?? 'text').toLowerCase()
        if (IGNORED_INPUTS.has(type)) break
        const name = prop(element, 'name')
        const key = `${type}:${name ?? ''}`
        const grouped =
          (type === 'radio' || type === 'checkbox') &&
          name !== null &&
          (type === 'radio' || (counts.get(key) ?? 0) > 1)
        if (!grouped) {
          fields.push({
            label: labelOf(element, above),
            type,
            required,
            options: [],
          })
          break
        }
        const option = labelOf(element, above)
        const existing = groups.get(key)
        if (existing === undefined) {
          const group = {
            label: questionOf(above, name),
            type,
            required,
            options: option === '' ? [] : [option],
          }
          groups.set(key, group)
          fields.push(group)
        } else {
          if (option !== '') existing.options.push(option)
          if (required) (existing as { required: boolean }).required = true
        }
        break
      }
      case 'select': {
        const options = [...selectOptions(element)]
        fields.push({
          label: labelOf(element, above),
          type:
            prop(element, 'multiple') === null ? 'select' : 'select, multiple',
          required,
          options,
        })
        break
      }
      case 'textarea':
        fields.push({
          label: labelOf(element, above),
          type: 'textarea',
          required,
          options: [],
        })
        break
    }
  }
  return fields
}

/** A form's name: the legend that holds all of it, its aria-label, or its id. */
const formName = (form: Element): string | null => {
  // The buttons that send the form sit beside the fieldset that names it.
  const parts = form.children.filter(
    (child): child is Element =>
      isElement(child) &&
      child.tagName !== 'button' &&
      !(
        child.tagName === 'input' &&
        IGNORED_INPUTS.has((prop(child, 'type') ?? 'text').toLowerCase())
      ),
  )
  const only =
    parts.length === 1 && parts[0]?.tagName === 'fieldset' ? parts[0] : null
  const legend = only?.children.find(
    (child): child is Element => isElement(child) && child.tagName === 'legend',
  )
  const fromLegend = legend === undefined ? '' : textOf(legend)
  const label = prop(form, 'ariaLabel')?.replace(/\s+/g, ' ').trim() ?? ''
  const id = prop(form, 'id') ?? ''
  return fromLegend !== '' ? fromLegend : label !== '' ? label : id || null
}

const text = (value: string) => ({ type: 'text' as const, value })

const formNodes = (form: Element, forms: Forms): RootContent[] => {
  const name = formName(form)
  const items: ListItem[] = formFields(form, forms).map((field) => {
    const kind = [field.type, ...(field.required ? ['required'] : [])].join(
      ', ',
    )
    const options =
      field.options.length === 0 ? '' : `: ${field.options.join(', ')}`
    return {
      type: 'listItem',
      spread: false,
      children: [
        {
          type: 'paragraph',
          children: [text(`${field.label || 'Unnamed'} (${kind})${options}`)],
        },
      ],
    }
  })
  const heading: RootContent = {
    type: 'heading',
    depth: 3,
    children: [text(name === null ? 'Form' : `Form: ${name}`)],
  }
  if (items.length === 0) return [heading]
  const list: List = {
    type: 'list',
    ordered: false,
    spread: false,
    children: items,
  }
  return [heading, list]
}

/**
 * Rewrites what Dossier's rules cover into lines, before the general
 * conversion: SVG, Mermaid, math, forms and parts without text. Other
 * elements keep their children, rewritten the same way.
 */
const prepare = (node: Element, forms: Forms): Element => {
  const children: (ElementContent | Line)[] = []
  for (const child of node.children) {
    if (!isElement(child)) {
      children.push(child)
      continue
    }
    const tag = child.tagName
    // Controls outside a form hold values, never questions.
    if (SKIPPED.has(tag) || CONTROLS.has(tag)) continue
    if (tag === 'svg') {
      const found = svgLine(child)
      if (found !== null) children.push(found)
      continue
    }
    const kinds = classes(child)
    if (tag === 'pre' && kinds.includes('mermaid')) {
      children.push(
        line(`\`\`\`mermaid\n${rawTextOf(child).trim()}\n\`\`\``, true),
      )
      continue
    }
    if (kinds.includes('math') && kinds.includes('display')) {
      children.push(line(`$$\n${rawTextOf(child).trim()}\n$$`, true))
      continue
    }
    if (kinds.includes('math') && kinds.includes('inline')) {
      children.push(line(`$${rawTextOf(child).trim()}$`, false))
      continue
    }
    if (tag === 'form') {
      children.push({
        type: 'dossierForm',
        nodes: formNodes(child, forms),
      } as unknown as ElementContent)
      continue
    }
    const placeholder = PLACEHOLDER[tag]
    const custom = isCustomElementName(tag)
    const image = prop(child, 'role') === 'img'
    if (
      (placeholder !== undefined || custom || image) &&
      textOf(child) === ''
    ) {
      const name = nameOf(child)
      const kind = placeholder ?? (image ? 'Image' : tag)
      if (name !== null) children.push(line(`[${kind}: ${name}]`, false))
      else if (placeholder !== undefined)
        children.push(line(`[${kind}]`, false))
      continue
    }
    children.push(prepare(child, forms))
  }
  return { ...node, children: children as ElementContent[] }
}

const lineHandler: NodeHandle = (_state, node: Line) => {
  const html: Html = { type: 'html', value: node.value }
  return node.block ? { type: 'paragraph', children: [html] } : html
}

const formHandler: NodeHandle = (_state, node: { nodes: RootContent[] }) =>
  node.nodes as MdastNodes[]

const hasH1 = (node: HastNodes): boolean =>
  node.type === 'element'
    ? node.tagName === 'h1' || node.children.some(hasH1)
    : node.type === 'root'
      ? node.children.some(hasH1)
      : false

const find = (node: HastNodes, tag: string): Element | null => {
  if (node.type === 'element' && node.tagName === tag) return node
  if (node.type !== 'element' && node.type !== 'root') return null
  for (const child of node.children) {
    const found = find(child, tag)
    if (found !== null) return found
  }
  return null
}

/** The agent version of a page with no companion, without the pointer line. */
export const toMarkdown = (source: string): string => {
  const tree = fromParse5(parse(source)) as HastRoot
  const html = find(tree, 'html')
  const head = html === null ? null : find(html, 'head')
  const body = html === null ? null : find(html, 'body')
  const title = head === null ? null : find(head, 'title')
  const titleText = title === null ? '' : textOf(title)
  // A hidden <html> or <body> hides the whole page.
  const shown =
    html === null || body === null || isHidden(html) || isHidden(body)
      ? null
      : withoutPlaceholders({ ...body, tagName: 'div' })
  const seen = shown === null ? null : visible(shown)
  const prepared = seen === null ? null : prepare(seen, formsOf(seen))
  const root: HastRoot = {
    type: 'root',
    children: prepared === null ? [] : prepared.children,
  }
  const mdast = toMdast(root, {
    nodeHandlers: { dossierLine: lineHandler, dossierForm: formHandler },
  }) as MdastRoot
  if (titleText !== '' && !(prepared !== null && hasH1(prepared))) {
    mdast.children.unshift({
      type: 'heading',
      depth: 1,
      children: [text(titleText)],
    })
  }
  return writeMarkdown(mdast, {
    bullet: '-',
    emphasis: '_',
    fences: true,
    listItemIndent: 'one',
    rule: '-',
    extensions: [gfmToMarkdown()],
  }).trimEnd()
}
