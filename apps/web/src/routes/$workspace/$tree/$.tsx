import { createFileRoute, notFound, redirect } from '@tanstack/react-router'

import { ListingScreen } from '../../../components/listing-screen'
import { NoAccessScreen } from '../../../components/no-access'
import { isScreenFailure } from '../../../server/failure'
import { listingView, type ListingView } from '../../../server/listing'
import { noAccessView } from '../../../server/no-access'

type Loaded =
  | { readonly kind: 'listing'; readonly view: ListingView }
  | { readonly kind: 'no-access'; readonly email: string | null }

export const Route = createFileRoute('/$workspace/$tree/$')({
  // No workspace is named _: a /_/ path no screen has is not found.
  beforeLoad: ({ params }) => {
    if (params.workspace === '_') throw notFound()
  },
  loader: async ({ params, location }): Promise<Loaded> => {
    const view = await listingView({
      data: {
        workspace: params.workspace,
        tree: params.tree,
        path: params._splat ?? '',
      },
    })
    if (!isScreenFailure(view)) return { kind: 'listing', view }
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
          loaderData?.kind === 'listing'
            ? `${loaderData.view.folder.name} · ${loaderData.view.deployment}`
            : 'Dossier',
      },
    ],
  }),
  component: ListingRoute,
})

function ListingRoute() {
  const loaded = Route.useLoaderData()
  return loaded.kind === 'no-access' ? (
    <NoAccessScreen email={loaded.email} />
  ) : (
    <ListingScreen view={loaded.view} />
  )
}
