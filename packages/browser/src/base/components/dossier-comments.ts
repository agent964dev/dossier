// <dossier-comments>: the page's comment threads, kept as data files in the
// comments folder beside the page. The kit loader imports this module after
// the page client has set `window.dossier`, and the element uses only that
// public client, so a kit's own `_components/dossier-comments.js` can
// replace it and write the same files.
import type { Dossier } from '../../page-client/create-page-client.ts'
import { define } from './dossier-comments/element.ts'

export {
  DossierComments,
  define,
  type CommentsDetail,
  type CommentsStateDetail,
} from './dossier-comments/element.ts'
export {
  pinFromPoint,
  pinPosition,
  placeThreads,
  type PlacedThread,
} from './dossier-comments/threads.ts'

const page =
  typeof window === 'undefined'
    ? undefined
    : (window as Window & { readonly dossier?: Dossier })

if (page?.dossier !== undefined && typeof customElements !== 'undefined') {
  define(customElements, page.dossier)
}
