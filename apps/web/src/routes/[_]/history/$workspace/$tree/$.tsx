import {
  createFileRoute,
  redirect,
  useLocation,
  useRouter,
} from '@tanstack/react-router'

import { AppHeader } from '../../../../../components/app-header'
import {
  HistoryScreen,
  type OpenedPush,
} from '../../../../../components/history-screen'
import { NoAccessScreen } from '../../../../../components/no-access'
import { isScreenFailure } from '../../../../../server/failure'
import {
  historyView,
  pushView,
  type HistoryView,
} from '../../../../../server/history'
import { noAccessView } from '../../../../../server/no-access'

interface HistorySearch {
  /** The push opened beside the list, or instead of it on phones. */
  readonly push?: number
}

type Loaded =
  | {
      readonly kind: 'history'
      readonly view: HistoryView
      readonly folder: boolean
      readonly opened: OpenedPush | null
    }
  | { readonly kind: 'no-access'; readonly email: string | null }

const pushOf = (value: unknown): number | undefined => {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' &&
    Number.isSafeInteger(number) &&
    number > 0
    ? number
    : undefined
}

export const Route = createFileRoute('/_/history/$workspace/$tree/$')({
  validateSearch: (search: Record<string, unknown>): HistorySearch => {
    const push = pushOf(search.push)
    return push === undefined ? {} : { push }
  },
  loaderDeps: ({ search }) => ({ push: search.push }),
  loader: async ({ params, location, deps }): Promise<Loaded> => {
    const path = params._splat ?? ''
    // A folder's history is asked with a trailing slash, as its link is.
    const folder = path === '' || location.pathname.endsWith('/')
    const view = await historyView({
      data: {
        workspace: params.workspace,
        tree: params.tree,
        path,
        folder,
        cursor: null,
      },
    })
    if (isScreenFailure(view)) {
      if (view.error.code === 'sign_in_required') {
        throw redirect({
          href: `/_/sign-in?next=${encodeURIComponent(location.href)}`,
        })
      }
      // History is for write holders: anyone else sees what a link they
      // cannot open shows.
      if (view.error.code !== 'not_found' && view.error.code !== 'forbidden') {
        throw new Error(view.error.message)
      }
      const who = await noAccessView()
      return {
        kind: 'no-access',
        email: isScreenFailure(who) ? null : who.email,
      }
    }
    let opened: OpenedPush | null = null
    if (deps.push !== undefined) {
      const push = await pushView({
        data: { target: view.target, number: deps.push },
      })
      opened = isScreenFailure(push)
        ? {
            number: deps.push,
            failure:
              push.error.code === 'not_found'
                ? `Push ${deps.push} changed nothing in ${view.folder.name}, or is not in its history.`
                : push.error.message,
          }
        : { number: deps.push, view: push }
    }
    return { kind: 'history', view, folder, opened }
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title:
          loaderData?.kind === 'history'
            ? `History · ${loaderData.view.folder.name} · ${loaderData.view.deployment}`
            : 'Dossier',
      },
    ],
  }),
  component: HistoryRoute,
})

function HistoryRoute() {
  const loaded = Route.useLoaderData()
  const params = Route.useParams()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const here = useLocation({ select: (location) => location.pathname })
  if (loaded.kind === 'no-access') {
    return <NoAccessScreen email={loaded.email} />
  }
  return (
    <div className="min-h-dvh">
      <AppHeader email={loaded.view.me.email} label="History" />
      <HistoryScreen
        view={loaded.view}
        at={{
          workspace: params.workspace,
          tree: params.tree,
          path: params._splat ?? '',
          folder: loaded.folder,
        }}
        opened={loaded.opened}
        pushHref={(number) =>
          number === null ? here : `${here}?push=${number}`
        }
        onOpenPush={(number) =>
          void navigate({
            search: number === null ? {} : { push: number },
            // A push opened on a phone replaces the list: start at its top.
            resetScroll: true,
          })
        }
        onRestored={() => void router.invalidate()}
      />
    </div>
  )
}
