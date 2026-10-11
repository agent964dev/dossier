import { createFileRoute, redirect } from '@tanstack/react-router'

import { NoAccessScreen } from '../../components/no-access'
import { isScreenFailure } from '../../server/failure'
import { noAccessView } from '../../server/no-access'

// A workspace's own link sends its members to the home; anyone else gets
// here, to the one no-access page.
export const Route = createFileRoute('/$workspace/')({
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
