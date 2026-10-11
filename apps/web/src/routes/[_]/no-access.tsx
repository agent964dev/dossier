import { createFileRoute, redirect } from '@tanstack/react-router'

import { NoAccessScreen } from '../../components/no-access'
import { isScreenFailure } from '../../server/failure'
import { noAccessView } from '../../server/no-access'

/** The one no-access page; the edge renders it at the link that was asked. */
export const Route = createFileRoute('/_/no-access')({
  loader: async ({ location }) => {
    const who = await noAccessView()
    if (isScreenFailure(who)) {
      if (who.error.code === 'sign_in_required') {
        throw redirect({
          href: `/_/sign-in?next=${encodeURIComponent(location.href)}`,
        })
      }
      throw new Error(who.error.message)
    }
    return who
  },
  head: () => ({ meta: [{ title: 'Dossier' }] }),
  component: () => <NoAccessScreen email={Route.useLoaderData().email} />,
})
