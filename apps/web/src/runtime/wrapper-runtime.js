/**
 * The wrapper runtime.
 *
 * The wrapper page inlines this file under its nonce. It reads the bootstrap
 * block the Worker embedded, keeps an overlay over the frame until the frame
 * runtime reports ready and acknowledges the apply, and never lets the document
 * appear with the author's defaults in place of the saved values.
 *
 * In this phase Save is rendered disabled for everyone, so the only states are
 * loading, ready, and the load failure with its Retry.
 */
;(() => {
  /** Five seconds without ready and applied is a load failure. */
  const LOAD_TIMEOUT_MS = 5000
  const PINNED_PATH = /^\/d\/[a-z0-9]{12}\/v\/[1-9][0-9]*$/u

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
  if (
    bootstrapNode === null ||
    frame === null ||
    statusLine === null ||
    overlay === null ||
    loadingPanel === null ||
    errorPanel === null ||
    retry === null
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
  const documentId = snapshot.documentId
  const pinned = PINNED_PATH.test(window.location.pathname)

  // Save is disabled for everyone in this phase, so the status line only has to
  // say why the page is read only.
  statusLine.textContent = !bootstrap.frameHasRuntime
    ? 'Published before saved values'
    : pinned
      ? 'Older version, read only'
      : 'Read only'

  // A version published before the document became stateful carries no manifest
  // and no runtime, so there is nothing to wait for.
  if (!bootstrap.frameHasRuntime) {
    overlay.hidden = true
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
  }

  const showFailure = () => {
    window.clearTimeout(timer)
    concealDocument()
    loadingPanel.hidden = true
    errorPanel.hidden = false
    overlay.hidden = false
    retry.disabled = false
    retry.focus()
  }

  const showDocument = () => {
    window.clearTimeout(timer)
    frame.removeAttribute('inert')
    frame.removeAttribute('aria-hidden')
    overlay.hidden = true
  }

  const arm = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(showFailure, LOAD_TIMEOUT_MS)
  }

  const postApply = () => {
    /** @type {Record<string, DossierFieldValue>} */
    const values = {}
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
        ? `?version=${encodeURIComponent(String(bootstrap.frameVersion))}`
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
