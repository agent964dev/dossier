/**
 * Types for the two runtime scripts and the bridge between them.
 *
 * Both scripts are classic inline scripts, not modules, so these are ambient
 * declarations rather than exports. Only src/runtime/tsconfig.runtime.json
 * checks the JavaScript against them; the app's tsconfig excludes this folder.
 */

/** The nine field types the scanner can put in a manifest. */
type DossierFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'radio'
  | 'select'
  | 'select-multiple'
  | 'json'

/** How the frame runtime reads and writes one field. */
interface DossierRuntimeField {
  readonly type: DossierFieldType
  readonly read: () => unknown
  readonly write: (value: unknown) => void
}

/** What an author's script hands to window.dossierState.register. */
interface DossierFieldRegistration {
  readonly name: string
  readonly read: () => unknown
  readonly write: (value: unknown) => void
  readonly onChange?: (notify: () => void) => void
}

/** The object the frame runtime publishes before any author script runs. */
interface DossierStateApi {
  readonly register: (spec: DossierFieldRegistration) => void
}

/** One field of an apply: the value to write and the type it was stored as. */
interface DossierFieldValue {
  readonly value: unknown
  readonly type: DossierFieldType
}

/** wrapper -> frame: write these values into the document. */
interface DossierApplyMessage {
  readonly type: 'apply'
  readonly documentId: string
  readonly fields: Readonly<Record<string, DossierFieldValue>>
}

/** wrapper -> frame: answer with every field that differs from the memory. */
interface DossierCollectMessage {
  readonly type: 'collect'
  readonly documentId: string
}

/**
 * wrapper -> frame: one round trip after a save or after "Review latest saved
 * version". `acknowledge` holds the raw values this tab just wrote, keyed by
 * name; `apply` holds the snapshot to write into every other field.
 */
interface DossierRebaseMessage {
  readonly type: 'rebase'
  readonly documentId: string
  readonly acknowledge: Readonly<Record<string, unknown>>
  readonly apply: Readonly<Record<string, DossierFieldValue>>
}

type DossierWrapperMessage =
  | DossierApplyMessage
  | DossierCollectMessage
  | DossierRebaseMessage

/** frame -> wrapper: the DOM is scanned and author scripts have run. */
interface DossierReadyMessage {
  readonly type: 'ready'
  readonly documentId: string
  readonly fields: readonly {
    readonly name: string
    readonly type: DossierFieldType
  }[]
  readonly unregistered: readonly string[]
}

/** frame -> wrapper: the answer to apply; the wrapper drops the overlay. */
interface DossierAppliedMessage {
  readonly type: 'applied'
  readonly documentId: string
}

/** frame -> wrapper: these fields were edited since the last apply. */
interface DossierChangedMessage {
  readonly type: 'changed'
  readonly documentId: string
  readonly names: readonly string[]
}

/** frame -> wrapper: the answer to collect. */
interface DossierValuesMessage {
  readonly type: 'values'
  readonly documentId: string
  readonly fields: Readonly<Record<string, unknown>>
  /** Fields whose registered reader failed or returned a non-JSON value. */
  readonly failed: readonly string[]
}

/**
 * frame -> wrapper: the answer to rebase. `applied` is what the runtime wrote,
 * `stillDirty` is every field whose value still differs from the memory.
 */
interface DossierRebasedMessage {
  readonly type: 'rebased'
  readonly documentId: string
  readonly applied: readonly string[]
  readonly stillDirty: readonly string[]
}

type DossierFrameMessage =
  | DossierReadyMessage
  | DossierAppliedMessage
  | DossierChangedMessage
  | DossierValuesMessage
  | DossierRebasedMessage

/** One field of the snapshot the State service reads. */
interface DossierFieldSnapshot {
  readonly value: unknown
  readonly revision: number
  readonly type: DossierFieldType
}

/** The snapshot State.read returns, plus the viewer and canSave it adds. */
interface DossierSnapshot {
  readonly documentId: string
  readonly version: number
  readonly revision: number
  readonly updatedAt: string | null
  readonly fields: Readonly<Record<string, DossierFieldSnapshot>>
  readonly canSave: boolean
  readonly viewer: 'editor' | 'granted' | 'link' | 'reader'
}

/** The JSON block a normal wrapper embeds as #dossier-bootstrap. */
interface DossierSnapshotBootstrap {
  readonly snapshot: DossierSnapshot
  readonly frameTicket: string
  readonly frameVersion: number
  readonly frameHasRuntime: boolean
  readonly csrfToken?: string
}

/** Link wrappers carry no values or ticket before the fragment is verified. */
interface DossierLinkBootstrap {
  readonly documentId: string
}

type DossierBootstrap = DossierSnapshotBootstrap | DossierLinkBootstrap

/** The GET /d/:id/state response used to refresh a frame ticket. */
interface DossierStateSurface extends DossierSnapshot {
  readonly title: string
  readonly frameTicket: string
  readonly frameVersion: number
  readonly frameHasRuntime: boolean
  /** Present for a signed-in viewer; the wrapper sends it on every POST. */
  readonly csrfToken?: string
}

interface Window {
  dossierState?: DossierStateApi
}
