/**
 * The frame runtime.
 *
 * HTMLRewriter prepends this file, wrapped in a classic script tag, to the head
 * of a stateful document, so it runs before any author script and
 * window.dossierState exists by the time a custom control registers.
 *
 * It is a value map with a memory, not a form library. `fields` says how to
 * read and write each field; `memory` holds the serialized value the runtime
 * last applied. The memory alone decides whether a person has edited a field,
 * which is why apply never overwrites what someone is typing.
 */
;(() => {
  /** Same grammar the scanner enforces at upload. */
  const NAME = /^[A-Za-z0-9_.-]{1,64}$/u
  const FRAME_ROUTE = /^\/d\/([a-z0-9]{12})(?:\/v\/[1-9][0-9]*)?\/frame$/u

  const route = FRAME_ROUTE.exec(window.location.pathname)
  const documentId = route === null ? '' : route[1]
  const parentWindow = window.parent

  /** @type {Map<string, DossierRuntimeField>} */
  const fields = new Map()
  /** @type {Map<string, string>} */
  const memory = new Map()
  /** Declared names in document order, for the ready message. @type {string[]} */
  const order = []
  /** Null until the DOM is scanned; a late registration is checked against it. @type {Set<string> | null} */
  let declared = null
  /** @type {Set<string>} */
  const pending = new Set()
  let reportScheduled = false

  /** @type {(value: unknown) => string} */
  const serialize = (value) => {
    const serialized = JSON.stringify(value === undefined ? null : value)
    if (serialized === undefined) {
      throw new TypeError('the field value is not JSON serializable')
    }
    return serialized
  }

  /** @type {(message: DossierFrameMessage) => void} */
  const post = (message) => {
    parentWindow.postMessage(message, '*')
  }

  /**
   * Tells the wrapper a field was edited. Throttled to one message per frame so
   * a drag on a range input does not flood the bridge.
   * @type {(name: string) => void}
   */
  const report = (name) => {
    pending.add(name)
    if (reportScheduled) return
    reportScheduled = true
    window.requestAnimationFrame(() => {
      reportScheduled = false
      const names = [...pending]
      pending.clear()
      if (names.length > 0) post({ type: 'changed', documentId, names })
    })
  }

  /**
   * The author-facing half of the contract. A registration for a name no
   * element declares is ignored, so the server's manifest stays the source of
   * truth for which fields exist.
   * @type {(spec: unknown) => void}
   */
  const register = (spec) => {
    const candidate =
      typeof spec === 'object' && spec !== null
        ? /** @type {Partial<DossierFieldRegistration>} */ (spec)
        : null
    if (
      candidate === null ||
      typeof candidate.name !== 'string' ||
      typeof candidate.read !== 'function' ||
      typeof candidate.write !== 'function'
    ) {
      console.error('dossier: register needs a name, a read, and a write.')
      return
    }
    const name = candidate.name
    if (declared !== null && !declared.has(name)) {
      console.error(`dossier: no element declares data-state="${name}".`)
      return
    }
    const read = candidate.read
    const write = candidate.write
    fields.set(name, { type: 'json', read, write })
    if (typeof candidate.onChange !== 'function') return
    try {
      candidate.onChange(() => report(name))
    } catch (error) {
      console.error(`dossier: onChange failed for "${name}".`, error)
    }
  }

  window.dossierState = { register }

  /**
   * The scanner reads the type attribute rather than the parsed IDL type, so an
   * unknown input type is a text field on both sides.
   * @type {(element: Element) => DossierFieldType}
   */
  const fieldTypeOf = (element) => {
    const tagName = element.tagName.toLowerCase()
    if (tagName === 'input') {
      const inputType = (element.getAttribute('type') ?? '').toLowerCase()
      if (inputType === 'radio') return 'radio'
      if (inputType === 'checkbox') return 'checkbox'
      if (inputType === 'number') return 'number'
      if (inputType === 'date') return 'date'
      return 'text'
    }
    if (tagName === 'textarea') return 'textarea'
    if (tagName === 'select') {
      return element.hasAttribute('multiple') ? 'select-multiple' : 'select'
    }
    return 'json'
  }

  /** @type {(value: unknown) => string} */
  const asText = (value) =>
    value === null || value === undefined ? '' : String(value)

  /**
   * @type {(type: DossierFieldType, elements: Element[]) => DossierRuntimeField | null}
   */
  const controlField = (type, elements) => {
    const element = elements[0]
    if (type === 'radio') {
      const group = /** @type {HTMLInputElement[]} */ (
        elements.filter((candidate) => fieldTypeOf(candidate) === 'radio')
      )
      return {
        type,
        read: () => group.find((radio) => radio.checked)?.value ?? null,
        write: (value) => {
          const chosen =
            typeof value === 'string'
              ? group.find((radio) => radio.value === value)
              : undefined
          for (const radio of group) radio.checked = radio === chosen
        },
      }
    }
    if (type === 'checkbox') {
      const input = /** @type {HTMLInputElement} */ (element)
      return {
        type,
        read: () => input.checked,
        write: (value) => {
          input.checked = value === true
        },
      }
    }
    if (type === 'number') {
      const input = /** @type {HTMLInputElement} */ (element)
      return {
        type,
        // An empty or browser-rejected value reads as NaN, which is null here
        // and in the manifest the scanner wrote.
        read: () =>
          Number.isNaN(input.valueAsNumber) ? null : input.valueAsNumber,
        write: (value) => {
          input.value =
            typeof value === 'number' && Number.isFinite(value)
              ? String(value)
              : ''
        },
      }
    }
    if (type === 'date') {
      const input = /** @type {HTMLInputElement} */ (element)
      return {
        type,
        read: () => input.value,
        write: (value) => {
          input.value = typeof value === 'string' ? value : ''
        },
      }
    }
    if (type === 'select' || type === 'select-multiple') {
      const select = /** @type {HTMLSelectElement} */ (element)
      if (type === 'select-multiple') {
        return {
          type,
          read: () =>
            [...select.options]
              .filter((option) => option.selected)
              .map((option) => option.value),
          write: (value) => {
            const wanted = Array.isArray(value) ? value.map(String) : []
            for (const option of select.options) {
              option.selected = wanted.includes(option.value)
            }
          },
        }
      }
      return {
        type,
        // A list box with nothing selected is null, an empty dropdown is "".
        // The scanner draws the same line so the manifest default matches.
        read: () =>
          select.selectedIndex < 0 && select.size > 1 ? null : select.value,
        write: (value) => {
          if (typeof value === 'string') select.value = value
          else select.selectedIndex = -1
        },
      }
    }
    if (type === 'text' || type === 'textarea') {
      const input = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (
        element
      )
      return {
        type,
        read: () => input.value,
        write: (value) => {
          input.value = asText(value)
        },
      }
    }
    return null
  }

  /**
   * Every element that declares a field, in document order. querySelectorAll
   * never descends into template content, and an SVG subtree is skipped
   * explicitly: the same two exclusions the scanner applies at upload.
   * @type {() => Map<string, Element[]>}
   */
  const declarations = () => {
    /** @type {Map<string, Element[]>} */
    const groups = new Map()
    for (const element of document.querySelectorAll('[data-state]')) {
      if (element.closest('svg') !== null) continue
      const name = element.getAttribute('data-state')
      if (name === null || !NAME.test(name)) continue
      const group = groups.get(name)
      if (group) {
        group.push(element)
        continue
      }
      groups.set(name, [element])
      order.push(name)
    }
    return groups
  }

  /** @type {(name: string, elements: Element[]) => void} */
  const listen = (name, elements) => {
    for (const element of elements) {
      element.addEventListener('input', () => report(name))
      element.addEventListener('change', () => report(name))
    }
  }

  /** Runs once, after author scripts have registered their custom controls. */
  const scan = () => {
    const groups = declarations()
    declared = new Set(order)
    // A registration the manifest does not declare is dropped, not applied.
    const registered = [...fields.keys()]
    for (const name of registered) {
      if (declared.has(name)) continue
      fields.delete(name)
      console.error(`dossier: no element declares data-state="${name}".`)
    }

    /** @type {{ name: string, type: DossierFieldType }[]} */
    const summary = []
    /** @type {string[]} */
    const unregistered = []
    for (const name of order) {
      const elements = groups.get(name) ?? []
      if (elements.length === 0) continue
      const type = fieldTypeOf(elements[0])
      if (type === 'json') {
        if (fields.has(name)) summary.push({ name, type })
        else unregistered.push(name)
        continue
      }
      const field = controlField(type, elements)
      if (field === null) continue
      fields.set(name, field)
      summary.push({ name, type })
      listen(name, elements)
    }

    post({ type: 'ready', documentId, fields: summary, unregistered })
  }

  /**
   * Writes one field and says whether it took. The answer is what rebase
   * reports back as `applied`.
   * @type {(name: string, entry: DossierFieldValue) => boolean}
   */
  const applyField = (name, entry) => {
    const field = fields.get(name)
    // A field this document does not declare, or declares with another type,
    // never reaches the DOM. Its value stays in the snapshot for the CLI.
    if (field === undefined || field.type !== entry.type) return false
    if (memory.has(name)) {
      try {
        if (serialize(field.read()) !== memory.get(name)) return false
      } catch (error) {
        console.error(`dossier: read failed for "${name}".`, error)
        return false
      }
    }
    try {
      field.write(entry.value)
    } catch (error) {
      console.error(`dossier: write failed for "${name}".`, error)
      return false
    }
    memory.set(name, serialize(entry.value))
    return true
  }

  /**
   * The well-formed entries of an apply, in writing order: marked controls
   * first, then registered custom fields, so a control that renders from
   * another field sees the final values.
   * @type {(incoming: unknown) => [string, DossierFieldValue][]}
   */
  const writable = (incoming) => {
    const entries =
      typeof incoming === 'object' && incoming !== null
        ? Object.entries(incoming)
        : []
    /** @type {[string, DossierFieldValue][]} */
    const marked = []
    /** @type {[string, DossierFieldValue][]} */
    const custom = []
    for (const [name, entry] of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const value = /** @type {DossierFieldValue} */ (entry)
      if (typeof value.type !== 'string') continue
      if (value.type === 'json') custom.push([name, value])
      else marked.push([name, value])
    }
    return [...marked, ...custom]
  }

  /** Every field whose value differs from the memory, and only those. */
  const dirtyNames = () => {
    /** @type {string[]} */
    const names = []
    for (const [name, field] of fields) {
      try {
        if (serialize(field.read()) !== memory.get(name)) names.push(name)
      } catch (error) {
        console.error(`dossier: read failed for "${name}".`, error)
        names.push(name)
      }
    }
    return names
  }

  /** @type {(incoming: unknown) => void} */
  const apply = (incoming) => {
    for (const [name, entry] of writable(incoming)) applyField(name, entry)
    document.dispatchEvent(new CustomEvent('dossier:state-applied'))
    post({ type: 'applied', documentId })
  }

  /**
   * The answer to collect. The wrapper never says which fields to look at: it
   * asks for all of them and the memory decides what changed, which is why a
   * custom control that never calls notify() still saves.
   */
  const collect = () => {
    const values = /** @type {Record<string, unknown>} */ (Object.create(null))
    /** @type {string[]} */
    const failed = []
    for (const [name, field] of fields) {
      try {
        const value = field.read()
        if (serialize(value) !== memory.get(name)) values[name] = value
      } catch (error) {
        console.error(`dossier: read failed for "${name}".`, error)
        failed.push(name)
      }
    }
    post({ type: 'values', documentId, fields: values, failed })
  }

  /**
   * The one round trip after a save or after "Review latest saved version".
   * Acknowledged names take the value this tab just wrote, so a person who
   * keeps typing during their own save does not later conflict with their own
   * write. Every other field is written only while it still matches the
   * memory, which is how an edit nobody announced survives a rebase.
   * @type {(incoming: Partial<DossierRebaseMessage>) => void}
   */
  const rebase = (incoming) => {
    /** @type {Set<string>} */
    const acknowledged = new Set()
    const acknowledge = incoming.acknowledge
    if (typeof acknowledge === 'object' && acknowledge !== null) {
      for (const [name, value] of Object.entries(acknowledge)) {
        acknowledged.add(name)
        memory.set(name, serialize(value))
      }
    }

    /** @type {string[]} */
    const applied = []
    for (const [name, entry] of writable(incoming.apply)) {
      if (acknowledged.has(name)) continue
      if (applyField(name, entry)) applied.push(name)
    }

    const stillDirty = dirtyNames()
    document.dispatchEvent(new CustomEvent('dossier:state-applied'))
    post({ type: 'rebased', documentId, applied, stillDirty })
  }

  window.addEventListener('message', (event) => {
    if (event.source !== parentWindow) return
    const data = event.data
    if (typeof data !== 'object' || data === null) return
    const message = /** @type {Partial<DossierWrapperMessage>} */ (data)
    if (message.documentId !== documentId) return
    if (message.type === 'apply') {
      apply(/** @type {Partial<DossierApplyMessage>} */ (message).fields)
    } else if (message.type === 'collect') {
      collect()
    } else if (message.type === 'rebase') {
      rebase(/** @type {Partial<DossierRebaseMessage>} */ (message))
    }
  })

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scan(), { once: true })
  } else {
    scan()
  }
})()
