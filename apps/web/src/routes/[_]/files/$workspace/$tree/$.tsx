import { createFileRoute, redirect } from '@tanstack/react-router'

import { ListingScreen } from '../../../../../components/listing-screen'
import { NoAccessScreen } from '../../../../../components/no-access'
import { isScreenFailure } from '../../../../../server/failure'
import { listingView, type ListingView } from '../../../../../server/listing'
import { noAccessView } from '../../../../../server/no-access'

type Loaded =
  | { readonly kind: 'files'; readonly view: ListingView }
  | { readonly kind: 'no-access'; readonly email: string | null }

// A folder's listing even when it has index.html, which its link opens as a
// page: the way to share and manage such a folder. Who may see it is who may
// see its listing.
export const Route = createFileRoute('/_/files/$workspace/$tree/$')({
  loader: async ({ params, location }): Promise<Loaded> => {
    const view = await listingView({
      data: {
        workspace: params.workspace,
        tree: params.tree,
        path: params._splat ?? '',
        files: true,
      },
    })
    if (!isScreenFailure(view)) return { kind: 'files', view }
    if (view.error.code === 'sign_in_required') {
      throw redirect({
        href: `/_/sign-in?next=${encodeURIComponent(location.href)}`,
      })
    }
    if (view.error.code !== 'not_found') throw new Error(view.error.message)
    const who = await noAccessView()
    return {
      kind: 'no-access',
      email: isScreenFailure(who) ? null : who.email,
    }
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title:
          loaderData?.kind === 'files'
            ? `Files · ${loaderData.view.folder.name} · ${loaderData.view.deployment}`
            : 'Dossier',
      },
    ],
  }),
  component: FilesRoute,
})

function FilesRoute() {
  const loaded = Route.useLoaderData()
  return loaded.kind === 'no-access' ? (
    <NoAccessScreen email={loaded.email} />
  ) : (
    <ListingScreen view={loaded.view} label="Files" />
  )
}
