// Moves a stylesheet written for a shadow root into the page's own DOM, in
// three steps:
//
// - Scope: `:host` becomes `<scope>`, and every rule applies only inside it.
// - Zero: nesting is flattened and every selector is wrapped in :where(), so
//   no rule has specificity (a pseudo-element, which :where() cannot hold,
//   stays after it).
// - Keep the sheet's own cascade: each rule goes into a sublayer named for
//   the specificity it had, declared in ascending order inside the sheet's
//   own layer of the same name. Between two of the sheet's rules, the one
//   that was more specific is in a later layer and still wins, and source
//   order decides a tie, as before.
//
// The whole sheet sits in the layer `layer` (inside the base layer that
// addBaseStyles adds), so any page or kit CSS beats it.

interface Part {
  readonly prelude: string
  /** Null for a statement or a declaration, which ends with `;`. */
  readonly body: string | null
}

/** The parts at one level: statements and declarations, and `prelude{body}` blocks. */
const partsOf = (css: string): Part[] => {
  const parts: Part[] = []
  let at = 0
  let start = 0
  let depth = 0
  let open = -1
  let quote: string | null = null
  while (at < css.length) {
    const char = css[at]!
    if (quote !== null) {
      if (char === '\\') at += 1
      else if (char === quote) quote = null
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '{') {
      if (depth === 0) open = at
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        parts.push({
          prelude: css.slice(start, open).trim(),
          body: css.slice(open + 1, at),
        })
        start = at + 1
      }
    } else if (char === ';' && depth === 0) {
      parts.push({ prelude: css.slice(start, at).trim(), body: null })
      start = at + 1
    }
    at += 1
  }
  const rest = css.slice(start).trim()
  if (rest !== '') parts.push({ prelude: rest, body: null })
  return parts.filter((part) => part.prelude !== '' || part.body !== null)
}

/** A selector list split at its top-level commas. */
export const selectorsOf = (list: string): string[] => {
  const out: string[] = []
  let depth = 0
  let start = 0
  let quote: string | null = null
  for (let at = 0; at < list.length; at += 1) {
    const char = list[at]!
    if (quote !== null) {
      if (char === '\\') at += 1
      else if (char === quote) quote = null
    } else if (char === '"' || char === "'") quote = char
    else if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (char === ',' && depth === 0) {
      out.push(list.slice(start, at).trim())
      start = at + 1
    }
  }
  out.push(list.slice(start).trim())
  return out.filter((selector) => selector !== '')
}

type Specificity = readonly [number, number, number]

const ZERO: Specificity = [0, 0, 0]

const add = (a: Specificity, b: Specificity): Specificity => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
]

const compare = (a: Specificity, b: Specificity): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

const highest = (list: readonly Specificity[]): Specificity =>
  list.reduce((best, each) => (compare(each, best) > 0 ? each : best), ZERO)

/** Pseudo-elements, including the legacy one-colon forms. */
const PSEUDO_ELEMENT =
  /^::?(?:before|after|first-line|first-letter)$|^::[\w-]+$/i

const NAME = /^-?[_a-zA-Z -￿][\w -￿-]*/

/** The argument of the parenthesis that opens at `at`, and where it ends. */
const argumentAt = (selector: string, at: number) => {
  let depth = 0
  for (let end = at; end < selector.length; end += 1) {
    const char = selector[end]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0)
        return { text: selector.slice(at + 1, end), end: end + 1 }
    }
  }
  return { text: selector.slice(at + 1), end: selector.length }
}

/** A complex selector's specificity, as Selectors Level 4 counts it. */
export const specificityOf = (selector: string): Specificity => {
  let total: Specificity = ZERO
  let at = 0
  while (at < selector.length) {
    const char = selector[at]!
    if (char === '#') {
      const name = NAME.exec(selector.slice(at + 1))?.[0] ?? ''
      total = add(total, [1, 0, 0])
      at += 1 + name.length
    } else if (char === '.') {
      const name = NAME.exec(selector.slice(at + 1))?.[0] ?? ''
      total = add(total, [0, 1, 0])
      at += 1 + name.length
    } else if (char === '[') {
      let end = at
      let quote: string | null = null
      for (; end < selector.length; end += 1) {
        const c = selector[end]
        if (quote !== null) {
          if (c === quote) quote = null
        } else if (c === '"' || c === "'") quote = c
        else if (c === ']') break
      }
      total = add(total, [0, 1, 0])
      at = end + 1
    } else if (char === ':') {
      const colons = selector[at + 1] === ':' ? 2 : 1
      const name = NAME.exec(selector.slice(at + colons))?.[0] ?? ''
      const token = `${':'.repeat(colons)}${name}`
      let next = at + colons + name.length
      let argument: string | null = null
      if (selector[next] === '(') {
        const found = argumentAt(selector, next)
        argument = found.text
        next = found.end
      }
      const lower = name.toLowerCase()
      if (PSEUDO_ELEMENT.test(token)) total = add(total, [0, 0, 1])
      else if (lower === 'where') total = add(total, ZERO)
      else if (
        (lower === 'is' || lower === 'not' || lower === 'has') &&
        argument !== null
      ) {
        total = add(
          total,
          highest(selectorsOf(argument).map((s) => specificityOf(s))),
        )
      } else total = add(total, [0, 1, 0])
      at = next
    } else if (char === '*') {
      at += 1
    } else if (/[\w-]/.test(char) || char.charCodeAt(0) > 0x7f) {
      const name = NAME.exec(selector.slice(at))?.[0] ?? char
      total = add(total, [0, 0, 1])
      at += name.length
    } else {
      at += 1
    }
  }
  return total
}

/**
 * `selector` with zero specificity: wrapped in :where(), with a trailing
 * pseudo-element (and what follows it) left outside, where it must be.
 */
const zeroed = (selector: string): string => {
  let depth = 0
  for (let at = 0; at < selector.length; at += 1) {
    const char = selector[at]
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (char === ':' && depth === 0) {
      const colons = selector[at + 1] === ':' ? 2 : 1
      const name = NAME.exec(selector.slice(at + colons))?.[0] ?? ''
      if (PSEUDO_ELEMENT.test(`${':'.repeat(colons)}${name}`)) {
        const base = selector.slice(0, at).trim()
        return `:where(${base === '' ? '*' : base})${selector.slice(at)}`
      }
      at += colons - 1
    }
  }
  return `:where(${selector})`
}

/** One rule of the flattened sheet. */
interface Flat {
  /** The sheet's own layer it was in, or '' for none. */
  readonly layer: string
  /** The conditional at-rules around it, outermost first. */
  readonly conditions: readonly string[]
  readonly selector: string
  readonly specificity: Specificity
  readonly declarations: string
}

interface Parent {
  readonly selectors: readonly string[]
  readonly specificity: Specificity
}

/** A nested selector written out against its parent's selectors. */
const resolved = (selector: string, parent: Parent): string => {
  const is = `:is(${parent.selectors.join(', ')})`
  return selector.includes('&')
    ? selector.replaceAll('&', is)
    : `${is} ${selector}`
}

const flatten = (
  body: string,
  parent: Parent,
  layer: string,
  conditions: readonly string[],
  out: Flat[],
  layers: string[],
): void => {
  const nested = partsOf(body).filter((part) => part.body !== null)
  for (const { prelude, body: inner } of nested) {
    if (inner === null) continue
    if (/^@layer\s/.test(prelude)) {
      const name = prelude.slice('@layer'.length).trim()
      const full = layer === '' ? name : `${layer}.${name}`
      if (!layers.includes(full)) layers.push(full)
      flatten(inner, parent, full, conditions, out, layers)
    } else if (prelude.startsWith('@')) {
      flatten(inner, parent, layer, [...conditions, prelude], out, layers)
    } else {
      const own = selectorsOf(prelude).map((s) => resolved(s, parent))
      // `&` stands for :is(parent), so it adds the parent's specificity
      // each time it appears; a selector without it is relative to it once.
      const specificities = selectorsOf(prelude).map((s) => {
        const times = Math.max(1, s.split('&').length - 1)
        let total = specificityOf(s.replaceAll('&', ''))
        for (let i = 0; i < times; i += 1)
          total = add(total, parent.specificity)
        return total
      })
      const ruleDeclarations = partsOf(inner)
        .filter((part) => part.body === null && !part.prelude.startsWith('@'))
        .map((part) => part.prelude)
      if (ruleDeclarations.length > 0) {
        own.forEach((selector, index) => {
          out.push({
            layer,
            conditions,
            selector,
            specificity: specificities[index]!,
            declarations: ruleDeclarations.join(';'),
          })
        })
      }
      flatten(
        inner,
        {
          selectors: own,
          specificity: highest(specificities),
        },
        layer,
        conditions,
        out,
        layers,
      )
    }
  }
}

const bucketOf = (s: Specificity): string => `s${s[0]}-${s[1]}-${s[2]}`

/** The rules of one of the sheet's layers, each in its specificity's sublayer. */
const emit = (rules: readonly Flat[]): string => {
  const buckets = [...new Set(rules.map((r) => bucketOf(r.specificity)))]
    .map((name) => ({
      name,
      specificity: rules.find((r) => bucketOf(r.specificity) === name)!
        .specificity,
    }))
    .sort((a, b) => compare(a.specificity, b.specificity))
  if (buckets.length === 0) return ''
  const blocks = buckets.map(({ name }) => {
    const inside = rules
      .filter((r) => bucketOf(r.specificity) === name)
      .map((r) =>
        r.conditions.reduceRight(
          (text, condition) => `${condition}{${text}}`,
          `${zeroed(r.selector)}{${r.declarations}}`,
        ),
      )
      .join('')
    return `@layer ${name}{${inside}}`
  })
  return `@layer ${buckets.map((b) => b.name).join(',')};${blocks.join('')}`
}

const withoutComments = (css: string): string =>
  css.replace(/\/\*[\s\S]*?\*\//g, '')

/** The sheet's own layers in the order its statements and blocks name them. */
const layerOrder = (css: string, into: string[], prefix = ''): void => {
  for (const { prelude, body } of partsOf(css)) {
    if (!/^@layer\s/.test(prelude)) continue
    const names =
      body === null
        ? prelude
            .slice('@layer'.length)
            .split(',')
            .map((n) => n.trim())
        : [prelude.slice('@layer'.length).trim()]
    for (const name of names) {
      const full = prefix === '' ? name : `${prefix}.${name}`
      if (!into.includes(full)) into.push(full)
    }
    if (body !== null) layerOrder(body, into, names[0] ?? '')
  }
}

/**
 * `css` scoped to `scope`, with zero specificity everywhere and its own
 * cascade kept, in the layer `layer`.
 */
export const scopeCss = (css: string, scope: string, layer: string): string => {
  const sheet = withoutComments(css).replace(/:host(?![\w-])/g, '&')
  const layers: string[] = []
  layerOrder(sheet, layers)
  const rules: Flat[] = []
  flatten(
    sheet,
    { selectors: [`:where(${scope})`], specificity: ZERO },
    '',
    [],
    rules,
    layers,
  )
  // Rules outside the sheet's layers beat its layers, as unlayered rules do,
  // so they go in a last layer of their own.
  const named = layers.filter((name) => !name.includes('.'))
  const blocks = [...layers, ''].map((name) => {
    const text = emit(rules.filter((r) => r.layer === name))
    return `@layer ${name === '' ? 'direct' : name}{${text}}`
  })
  return `@layer ${layer}{@layer ${[...named, 'direct'].join(',')};${blocks.join('')}}`
}
