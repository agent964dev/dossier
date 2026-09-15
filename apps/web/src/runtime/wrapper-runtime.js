/**
 * The wrapper runtime.
 *
 * The wrapper page inlines this file under its nonce. It reads the bootstrap
 * block the Worker embedded, keeps an overlay over the frame until the frame
 * runtime reports ready and acknowledges the apply, and never lets the document
 * appear with the author's defaults in place of the saved values.
 *
 * From there it is the Save bar. It asks the frame what changed, posts those
 * fields with the revision it last acknowledged for each of them, and rebases
 * on the answer. A conflict, a changed version, a revoked authority, and a
 * network error all keep the draft on screen; none of them ever says Saved.
 */
;(() => {
  /** Five seconds without ready and applied is a load failure. */
  const LOAD_TIMEOUT_MS = 5000
  /** The frame answers in one turn, so this only catches a dead frame. */
  const ANSWER_TIMEOUT_MS = 5000
  /** A conflicting value is a hint in a one-line list, not the value itself. */
  const VALUE_PREVIEW = 120
  const PINNED_PATH = /^\/d\/[a-z0-9]{12}\/v\/[1-9][0-9]*$/u

  /**
   * @typedef {'loading' | 'ready' | 'loadFailed' | 'dirty' | 'saving'
   *   | 'conflict' | 'versionChanged' | 'denied'} WrapperState
   */

  /**
   * What the status line says instead of the state's own word. Only a saved
   * notice clears itself when the person edits again; a failure stays until
   * the next save attempt, so nothing quietly hides that a save did not land.
   * @typedef {object} StatusNotice
   * @property {'saved' | 'failed' | 'denied' | 'version'} kind
   * @property {string} text
   * @property {string} [href]
   * @property {string} [linkText]
   */

  /**
   * One pending round trip to the frame runtime.
   * @typedef {object} Waiter
   * @property {'values' | 'rebased'} answer
   * @property {(message: DossierFrameMessage) => void} resolve
   * @property {number} timer
   */

  /**
   * The shape of a refused save. The browser surface answers with the same
   * envelope /api does, so the wrapper only has to switch on the code.
   * @typedef {object} ErrorEnvelope
   * @property {string} [code]
   * @property {string} [message]
   * @property {{ fields?: unknown, currentVersion?: unknown }} [details]
   */

  const bootstrapNode = document.getElementById('dossier-bootstrap')
  const frame = /** @type {HTMLIFrameElement | null} */ (
    document.getElementById('dossier-frame')
  )
  const statusLine = document.getElementById('dossier-status')
  const overlay = document.getElementById('dossier-overlay')
  const loadingPanel = document.getElementById('dossier-overlay-loading')
  const errorPanel = document.getElementById('dossier-overlay-error')
  const retry = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('dossier-retry')
  )
  const save = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('dossier-save')
  )
  const saveRetry = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('dossier-save-retry')
  )
  const copyDraft = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('dossier-copy-draft')
  )
  const conflict = /** @type {HTMLDialogElement | null} */ (
    document.getElementById('dossier-conflict')
  )
  const conflictFields = document.getElementById('dossier-conflict-fields')
  const conflictKeep = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('dossier-conflict-keep')
  )
  const conflictReview = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('dossier-conflict-review')
  )
  const copyFallback = /** @type {HTMLDialogElement | null} */ (
    document.getElementById('dossier-copy-fallback')
  )
  const copyFallbackText = /** @type {HTMLTextAreaElement | null} */ (
    document.getElementById('dossier-copy-fallback-text')
  )
  const copyFallbackClose = /** @type {HTMLButtonElement | null} */ (
    document.getElementById('dossier-copy-fallback-close')
  )
  if (
    bootstrapNode === null ||
    frame === null ||
    statusLine === null ||
    overlay === null ||
    loadingPanel === null ||
    errorPanel === null ||
    retry === null ||
    save === null ||
    saveRetry === null ||
    copyDraft === null ||
    conflict === null ||
    conflictFields === null ||
    conflictKeep === null ||
    conflictReview === null ||
    copyFallback === null ||
    copyFallbackText === null ||
    copyFallbackClose === null
  ) {
    return
  }

  /** @type {DossierBootstrap | null} */
  let bootstrap = null
  try {
    bootstrap = /** @type {DossierBootstrap} */ (
      JSON.parse(bootstrapNode.textContent ?? '')
    )
  } catch (error) {
    console.error('dossier: the bootstrap block could not be read.', error)
  }
  if (bootstrap === null) return

  let snapshot = bootstrap.snapshot
  let loadedFrameVersion = bootstrap.frameVersion
  const documentId = snapshot.documentId
  const pinned = PINNED_PATH.test(window.location.pathname)
  const hasRuntime = bootstrap.frameHasRuntime === true
  // The same predicate the Worker used to render the button, recomputed here
  // so a tampered bootstrap cannot turn a read-only page into a saving one.
  const canSave = hasRuntime && !pinned && snapshot.canSave === true
  let csrfToken =
    typeof bootstrap.csrfToken === 'string' ? bootstrap.csrfToken : null

  const readOnlyStatus = !hasRuntime
    ? 'Published before saved values'
    : pinned
      ? 'Older version, read only'
      : 'Read only'

  /**
   * The value and revision this tab last acknowledged per field: what it
   * loaded, or what its own save wrote. A save bases on these, never on the
   * snapshot, so a field nobody here touched keeps its old pair and a later
   * save of it still conflicts.
   * @type {Map<string, DossierFieldSnapshot>}
   */
  const acked = new Map()

  /** @type {(next: DossierSnapshot) => void} */
  const seedAcked = (next) => {
    acked.clear()
    for (const [name, field] of Object.entries(next.fields ?? {})) {
      acked.set(name, field)
    }
  }
  seedAcked(snapshot)

  /** @type {Set<string>} */
  let dirty = new Set()
  /** @type {WrapperState} */
  let state = 'loading'
  /** @type {StatusNotice | null} */
  let notice = null
  /** @type {'save' | 'review' | null} */
  let operation = null
  /** @type {'save' | 'review' | null} */
  let retryAction = null
  let renderedStatus = ''

  /** The five fixed words, and nothing that depends on colour. */
  const statusText = () => {
    if (!canSave) return readOnlyStatus
    if (state === 'saving') return 'Saving'
    return dirty.size > 0 ? 'Unsaved changes' : 'Save'
  }

  const render = () => {
    document.body.dataset.saveState = state
    // Save stays enabled while a request is in flight: disabling it would drop
    // a keyboard user's focus mid-save. The shared operation guard refuses an
    // overlapping Save or Review latest instead.
    save.disabled =
      !canSave ||
      state === 'loading' ||
      state === 'loadFailed' ||
      state === 'denied'
    saveRetry.hidden = retryAction === null
    copyDraft.hidden = state !== 'denied' && state !== 'versionChanged'

    const text = notice === null ? statusText() : notice.text
    const href = notice?.href ?? ''
    const linkText = notice?.linkText ?? href
    const statusKey = JSON.stringify([text, href, linkText])
    if (statusKey !== renderedStatus) {
      /** @type {(Node | string)[]} */
      const parts = [text]
      if (href !== '') {
        const link = document.createElement('a')
        link.href = href
        link.target = '_blank'
        link.rel = 'noopener'
        link.textContent = linkText
        parts.push(link)
      }
      statusLine.replaceChildren(...parts)
      renderedStatus = statusKey
    }

    // Losing the authority to save should not also lose the keyboard.
    if (state === 'denied' && document.activeElement === save) copyDraft.focus()
  }

  /** @type {Waiter[]} */
  const waiting = []

  /** @type {(waiter: Waiter) => void} */
  const drop = (waiter) => {
    const index = waiting.indexOf(waiter)
    if (index >= 0) waiting.splice(index, 1)
    window.clearTimeout(waiter.timer)
  }

  /**
   * One request to the frame runtime and its single answer. The bridge carries
   * no correlation id because the wrapper never has two round trips in flight.
   * @type {(message: DossierWrapperMessage, answer: 'values' | 'rebased')
   *   => Promise<DossierFrameMessage>}
   */
  const ask = (message, answer) =>
    new Promise((resolve, reject) => {
      const target = frame.contentWindow
      if (target === null) {
        reject(new Error('the document frame is gone'))
        return
      }
      /** @type {Waiter} */
      const waiter = {
        answer,
        resolve,
        timer: window.setTimeout(() => {
          drop(waiter)
          reject(new Error(`the frame never answered ${message.type}`))
        }, ANSWER_TIMEOUT_MS),
      }
      waiting.push(waiter)
      target.postMessage(message, '*')
    })

  /**
   * Every field whose value differs from the frame's memory. The wrapper never
   * names fields: the memory decides, so a custom control that never called
   * notify() is collected like any other.
   * @type {() => Promise<Record<string, unknown>>}
   */
  const collect = async () => {
    const answer = /** @type {DossierValuesMessage} */ (
      await ask({ type: 'collect', documentId }, 'values')
    )
    if (typeof answer.fields !== 'object' || answer.fields === null) {
      throw new Error('the frame returned no collected values')
    }
    const values = Object.fromEntries(Object.entries(answer.fields))
    const failed = Array.isArray(answer.failed)
      ? answer.failed.filter((name) => typeof name === 'string')
      : []
    dirty = new Set([...Object.keys(values), ...failed])
    if (failed.length > 0) {
      throw new Error(`the frame could not read: ${failed.join(', ')}`)
    }
    return values
  }

  /**
   * One runtime round trip after a save or after "Review latest saved version".
   * The runtime is the authority on what it wrote and on what is still dirty.
   * @type {(next: DossierSnapshot, acknowledge: Record<string, unknown>)
   *   => Promise<void>}
   */
  const rebase = async (next, acknowledge) => {
    const fields = new Map(Object.entries(next.fields ?? {}))
    const apply = /** @type {Record<string, DossierFieldValue>} */ (
      Object.create(null)
    )
    for (const [name, field] of fields) {
      apply[name] = { value: field.value, type: field.type }
    }
    const answer = /** @type {DossierRebasedMessage} */ (
      await ask({ type: 'rebase', documentId, acknowledge, apply }, 'rebased')
    )

    snapshot = next
    // A submitted field takes the new revision even when the person kept
    // typing in it during the request, so their next save of that field does
    // not conflict with their own write.
    for (const [name, value] of Object.entries(acknowledge)) {
      acked.set(name, {
        value,
        revision: next.revision,
        type: fields.get(name)?.type ?? 'json',
      })
    }
    for (const name of Array.isArray(answer.applied) ? answer.applied : []) {
      const field = fields.get(name)
      if (field !== undefined) acked.set(name, field)
    }
    dirty = new Set(Array.isArray(answer.stillDirty) ? answer.stillDirty : [])
  }

  /**
   * @param {unknown} value
   * @returns {value is DossierSnapshot}
   */
  const isSnapshot = (value) => {
    if (typeof value !== 'object' || value === null) return false
    const candidate = /** @type {Partial<DossierSnapshot>} */ (value)
    return (
      candidate.documentId === documentId &&
      typeof candidate.revision === 'number' &&
      Number.isSafeInteger(candidate.revision) &&
      typeof candidate.version === 'number' &&
      Number.isSafeInteger(candidate.version) &&
      typeof candidate.fields === 'object' &&
      candidate.fields !== null
    )
  }

  /** @type {(value: unknown) => string} */
  const clock = (value) => {
    const parsed = typeof value === 'string' ? new Date(value) : new Date()
    const at = Number.isNaN(parsed.getTime()) ? new Date() : parsed
    return at.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  /** @type {(value: unknown) => string} */
  const preview = (value) => {
    if (typeof value === 'string' && value.length === 0) return '(empty)'
    let text = ''
    try {
      text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
    } catch {
      text = String(value)
    }
    return text.length > VALUE_PREVIEW
      ? `${text.slice(0, VALUE_PREVIEW)}…`
      : text
  }

  /** The draft is still on screen, so the state follows what is still dirty. */
  const settle = () => {
    state = dirty.size > 0 ? 'dirty' : 'ready'
    render()
  }

  /** Nothing was confirmed; keep the draft and retry the failed operation. */
  /** @type {(action: 'save' | 'review') => void} */
  const operationFailed = (action) => {
    notice = { kind: 'failed', text: 'Could not save' }
    retryAction = action
    settle()
  }

  const closeConflict = () => {
    if (conflict.open) conflict.close()
    notice = null
    retryAction = null
    settle()
    save.focus()
  }

  /** @type {(fields: unknown) => void} */
  const openConflict = (fields) => {
    const rows = Array.isArray(fields) ? fields : []
    conflictFields.replaceChildren(
      ...rows.map((row) => {
        const entry = /** @type {{ name?: unknown, value?: unknown }} */ (
          typeof row === 'object' && row !== null ? row : {}
        )
        const item = document.createElement('li')
        const name = document.createElement('b')
        name.textContent = typeof entry.name === 'string' ? entry.name : 'field'
        item.append(name, ` ${preview(entry.value)}`)
        return item
      }),
    )
    conflictFields.hidden = rows.length === 0
    notice = null
    retryAction = null
    state = 'conflict'
    render()
    if (!conflict.open) conflict.showModal()
    // The non-destructive choice takes the focus the modal traps.
    conflictKeep.focus()
  }

  /** @type {(current: unknown) => void} */
  const showVersionChanged = (current) => {
    const version = Number(current)
    notice = {
      kind: 'version',
      text: 'Unsaved changes · ',
      href: `/d/${documentId}`,
      linkText:
        Number.isSafeInteger(version) && version > 0
          ? `version ${version} is current`
          : 'open the current version',
    }
    retryAction = null
    state = 'versionChanged'
    render()
  }

  /**
   * "Review latest saved version". One GET and one rebase with nothing
   * acknowledged, so the snapshot reaches every clean field and the draft
   * stays exactly where it is. It shares the Save operation guard so an older
   * GET can never land after this tab completes a newer save.
   */
  const reviewLatest = async () => {
    if (operation !== null) return
    operation = 'review'
    notice = null
    retryAction = null
    settle()

    try {
      const response = await fetch(`/d/${documentId}/state`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`state GET answered ${response.status}`)
      /** @type {unknown} */
      const body = await response.json()
      if (!isSnapshot(body)) throw new Error('state GET returned no snapshot')
      const surface = /** @type {DossierStateSurface} */ (body)
      if (typeof surface.csrfToken === 'string') csrfToken = surface.csrfToken
      if (body.version !== loadedFrameVersion) {
        showVersionChanged(body.version)
        return
      }
      if (body.revision < snapshot.revision) {
        throw new Error('state GET returned an older snapshot')
      }
      await rebase(body, Object.create(null))
      notice = null
      settle()
    } catch (error) {
      console.error('dossier: the latest saved values did not load.', error)
      operationFailed('review')
    } finally {
      operation = null
    }
  }

  const onSave = async () => {
    if (!canSave || operation !== null) return
    operation = 'save'
    notice = null
    retryAction = null
    state = 'saving'
    render()

    try {
      /** @type {Record<string, unknown>} */
      let values
      try {
        values = await collect()
      } catch (error) {
        console.error('dossier: the document frame did not answer.', error)
        operationFailed('save')
        return
      }

      const changes = Object.entries(values).map(([name, value]) => ({
        name,
        value,
        base: acked.get(name)?.revision ?? 0,
      }))

      /** @type {Response} */
      let response
      try {
        /** @type {Record<string, string>} */
        const headers = {
          accept: 'application/json',
          'content-type': 'application/json',
        }
        if (csrfToken !== null) headers['x-dossier-csrf'] = csrfToken
        response = await fetch(`/d/${documentId}/state`, {
          method: 'POST',
          credentials: 'same-origin',
          headers,
          body: JSON.stringify({ version: loadedFrameVersion, changes }),
        })
      } catch (error) {
        console.error('dossier: the save never reached the server.', error)
        operationFailed('save')
        return
      }

      /** @type {unknown} */
      const body = await response.json().catch(() => null)

      if (response.ok) {
        if (!isSnapshot(body)) {
          console.error('dossier: the save answered an unusable snapshot.')
          operationFailed('save')
          return
        }
        try {
          await rebase(body, values)
        } catch (error) {
          console.error('dossier: the frame did not answer the rebase.', error)
          operationFailed('save')
          return
        }
        // Something typed during the request is genuinely unsaved, so the
        // status says so rather than claiming the whole draft landed.
        notice =
          dirty.size > 0
            ? null
            : { kind: 'saved', text: `Saved · ${clock(body.updatedAt)}` }
        settle()
        return
      }

      const envelope = /** @type {ErrorEnvelope} */ (
        typeof body === 'object' && body !== null ? body : {}
      )
      if (response.status === 409 && envelope.code === 'state_conflict') {
        openConflict(envelope.details?.fields)
        return
      }
      if (
        response.status === 409 &&
        envelope.code === 'state_version_changed'
      ) {
        showVersionChanged(envelope.details?.currentVersion)
        return
      }
      if (
        response.status === 403 ||
        response.status === 404 ||
        response.status === 410
      ) {
        notice = {
          kind: 'denied',
          text: 'Could not save · saving is no longer allowed',
        }
        retryAction = null
        state = 'denied'
        render()
        return
      }
      console.error(`dossier: the save answered ${response.status}.`)
      operationFailed('save')
    } finally {
      operation = null
    }
  }

  save.addEventListener('click', () => {
    void onSave()
  })
  saveRetry.addEventListener('click', () => {
    const action = retryAction
    save.focus()
    if (action === 'review') void reviewLatest()
    else if (action === 'save') void onSave()
  })
  conflictKeep.addEventListener('click', () => {
    closeConflict()
  })
  conflict.addEventListener('cancel', (event) => {
    event.preventDefault()
    closeConflict()
  })
  conflictReview.addEventListener('click', () => {
    closeConflict()
    void reviewLatest()
  })

  let copyLabelTimer = 0
  /** @type {(text: string) => void} */
  const showCopyLabel = (text) => {
    window.clearTimeout(copyLabelTimer)
    copyDraft.textContent = text
    copyLabelTimer = window.setTimeout(() => {
      copyDraft.textContent = 'Copy draft'
    }, 4000)
  }

  /** @type {(json: string) => void} */
  const showCopyFallback = (json) => {
    window.clearTimeout(copyLabelTimer)
    copyDraft.textContent = 'Copy manually'
    copyFallbackText.value = json
    if (!copyFallback.open) copyFallback.showModal()
    copyFallbackText.focus()
    copyFallbackText.select()
  }

  copyDraft.addEventListener('click', () => {
    void (async () => {
      let json
      try {
        const draft = await collect()
        json = JSON.stringify(draft, null, 2)
        if (
          navigator.clipboard === undefined ||
          typeof navigator.clipboard.writeText !== 'function'
        ) {
          throw new Error('the Clipboard API is unavailable')
        }
        await navigator.clipboard.writeText(json)
        showCopyLabel('Draft copied')
      } catch (error) {
        console.error('dossier: the draft could not be copied.', error)
        if (typeof json === 'string') showCopyFallback(json)
        else showCopyLabel('Could not copy')
      }
    })()
  })
  copyFallbackClose.addEventListener('click', () => {
    copyFallback.close()
  })
  copyFallback.addEventListener('close', () => {
    copyDraft.textContent = 'Copy draft'
    copyDraft.focus()
  })

  render()

  // A version published before the document became stateful carries no
  // manifest and no runtime, so there is nothing to wait for.
  if (!hasRuntime) {
    state = 'ready'
    overlay.hidden = true
    render()
    return
  }

  let ready = false
  let applied = false
  let timer = 0

  const concealDocument = () => {
    frame.setAttribute('inert', '')
    frame.setAttribute('aria-hidden', 'true')
  }

  const showLoading = () => {
    concealDocument()
    errorPanel.hidden = true
    loadingPanel.hidden = false
    overlay.hidden = false
    state = 'loading'
    render()
  }

  const showFailure = () => {
    window.clearTimeout(timer)
    concealDocument()
    loadingPanel.hidden = true
    errorPanel.hidden = false
    overlay.hidden = false
    retry.disabled = false
    state = 'loadFailed'
    render()
    retry.focus()
  }

  const showDocument = () => {
    window.clearTimeout(timer)
    frame.removeAttribute('inert')
    frame.removeAttribute('aria-hidden')
    overlay.hidden = true
    settle()
  }

  const arm = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(showFailure, LOAD_TIMEOUT_MS)
  }

  const postApply = () => {
    const values = /** @type {Record<string, DossierFieldValue>} */ (
      Object.create(null)
    )
    for (const [name, field] of Object.entries(snapshot.fields ?? {})) {
      values[name] = { value: field.value, type: field.type }
    }
    frame.contentWindow?.postMessage(
      /** @type {DossierApplyMessage} */ ({
        type: 'apply',
        documentId,
        fields: values,
      }),
      '*',
    )
  }

  window.addEventListener('message', (event) => {
    const source = frame.contentWindow
    if (source === null || event.source !== source) return
    const data = event.data
    if (typeof data !== 'object' || data === null) return
    const message = /** @type {Partial<DossierFrameMessage>} */ (data)
    if (message.documentId !== documentId) return

    if (message.type === 'values' || message.type === 'rebased') {
      const answer = message.type
      const waiter = waiting.find((candidate) => candidate.answer === answer)
      if (waiter === undefined) return
      drop(waiter)
      waiter.resolve(/** @type {DossierFrameMessage} */ (message))
      return
    }

    if (message.type === 'changed') {
      const edited = /** @type {Partial<DossierChangedMessage>} */ (message)
      const names = edited.names
      if (!Array.isArray(names)) return
      for (const name of names) {
        if (typeof name === 'string') dirty.add(name)
      }
      // A stale "Saved · time" would be a lie the moment someone types; a
      // failure notice stays until the next attempt answers for itself.
      if (notice !== null && notice.kind === 'saved') notice = null
      if (state === 'ready') state = 'dirty'
      render()
      return
    }

    if (message.type === 'ready') {
      const unregistered = /** @type {Partial<DossierReadyMessage>} */ (message)
        .unregistered
      // A declared field whose script never registered would be saved from a
      // half-built page, so it fails the load instead.
      if (Array.isArray(unregistered) && unregistered.length > 0) {
        console.error(
          'dossier: these fields have no registration.',
          unregistered,
        )
        showFailure()
        return
      }
      ready = true
      postApply()
      return
    }

    if (message.type === 'applied' && ready && !applied) {
      applied = true
      showDocument()
    }
  })

  retry.addEventListener('click', async () => {
    ready = false
    applied = false
    retry.disabled = true
    showLoading()
    arm()
    frame.setAttribute('src', 'about:blank')

    try {
      const versionQuery = pinned
        ? `?version=${encodeURIComponent(String(loadedFrameVersion))}`
        : ''
      const response = await fetch(`/d/${documentId}/state${versionQuery}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`state GET answered ${response.status}`)
      const surface = /** @type {Partial<DossierStateSurface>} */ (
        await response.json()
      )
      if (
        surface.documentId !== documentId ||
        typeof surface.frameTicket !== 'string' ||
        surface.frameTicket.length === 0 ||
        typeof surface.frameVersion !== 'number' ||
        !Number.isSafeInteger(surface.frameVersion) ||
        surface.frameVersion < 1 ||
        typeof surface.fields !== 'object' ||
        surface.fields === null
      ) {
        throw new Error('state GET returned an invalid surface')
      }

      snapshot = /** @type {DossierSnapshot} */ (surface)
      loadedFrameVersion = surface.frameVersion
      // The frame is rebuilt from scratch, so its memory and this tab's
      // acknowledged pairs both start again from the snapshot it will apply.
      seedAcked(snapshot)
      dirty = new Set()
      notice = null
      retryAction = null
      if (typeof surface.csrfToken === 'string') csrfToken = surface.csrfToken
      render()

      const framePath = pinned
        ? `/d/${documentId}/v/${surface.frameVersion}/frame`
        : `/d/${documentId}/frame`
      frame.setAttribute(
        'src',
        `${framePath}?t=${encodeURIComponent(surface.frameTicket)}`,
      )
    } catch (error) {
      console.error('dossier: retry could not refresh the frame ticket.', error)
      showFailure()
    }
  })

  showLoading()
  arm()
})()
