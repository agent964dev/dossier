import { createFileRoute, Link, Outlet, redirect } from '@tanstack/react-router'

import { AppHeader } from '../../../../../components/app-header'
import { NoAccessScreen } from '../../../../../components/no-access'
import { Badge } from '../../../../../components/ui/badge'
import { WorkspaceMenu } from '../../../../../components/workspace-menu'
import { isScreenFailure } from '../../../../../server/failure'
import { noAccessView } from '../../../../../server/no-access'
import {
  settingsHeader,
  type SettingsHeader,
} from '../../../../../server/workspace-settings'

type Loaded =
  | { readonly kind: 'settings'; readonly header: SettingsHeader }
  | { readonly kind: 'no-access'; readonly email: string | null }
  | { readonly kind: 'refused'; readonly message: string }

export const Route = createFileRoute('/_/w/$workspace/settings')({
  loader: async ({ params, location }): Promise<Loaded> => {
    const header = await settingsHeader({
      data: { workspace: params.workspace },
    })
    if (!isScreenFailure(header)) return { kind: 'settings', header }
    if (header.error.code === 'sign_in_required') {
      throw redirect({
        href: `/_/sign-in?next=${encodeURIComponent(location.href)}`,
      })
    }
    // A suspended workspace says so to its members.
    if (header.error.code === 'forbidden') {
      return { kind: 'refused', message: header.error.message }
    }
    if (header.error.code !== 'not_found') throw new Error(header.error.message)
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
          loaderData?.kind === 'settings'
            ? `Settings · ${loaderData.header.workspace} · Dossier`
            : 'Dossier',
      },
    ],
  }),
  component: WorkspaceSettings,
})

const TAB =
  'relative -mb-px shrink-0 border-b-2 border-transparent px-0.5 pt-1 pb-2.5 text-[0.9375rem] text-neutral-400 outline-none transition-colors duration-200 ease-agent hover:text-neutral-100 focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[status=active]:border-brand-300 data-[status=active]:text-neutral-50'

function WorkspaceSettings() {
  const loaded = Route.useLoaderData()
  if (loaded.kind === 'no-access') {
    return <NoAccessScreen email={loaded.email} />
  }
  if (loaded.kind === 'refused') {
    return (
      <div className="min-h-dvh">
        <AppHeader email={null} />
        <main className="mx-auto flex max-w-xl flex-col gap-3 px-4 pt-10 text-center">
          <p className="font-clash text-xl font-semibold text-neutral-50">
            {loaded.message}
          </p>
        </main>
      </div>
    )
  }
  const { header } = loaded
  const params = { workspace: header.workspace }
  return (
    <div className="min-h-dvh">
      <AppHeader
        email={header.email}
        beside={
          <WorkspaceMenu
            current={header.workspace}
            workspaces={header.workspaces}
          />
        }
      />
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 pt-6 pb-16 sm:px-6">
        <div className="flex flex-col gap-2">
          <p className="font-mono text-xs text-neutral-500">
            {header.workspace} <span aria-hidden>/</span>{' '}
            <span className="text-neutral-300">settings</span>
          </p>
          <div className="flex items-end justify-between gap-3">
            <h1 className="min-w-0 font-clash text-[1.875rem] font-semibold tracking-[-0.03em] break-words text-neutral-50">
              {header.workspace}
            </h1>
            <Badge variant="outline" className="mb-2">
              Workspace
            </Badge>
          </div>
        </div>
        <nav
          aria-label="Workspace settings"
          className="-mt-2 flex gap-5 border-b border-border/80"
        >
          <Link
            to="/_/w/$workspace/settings"
            params={params}
            activeOptions={{ exact: true, includeSearch: false }}
            className={TAB}
          >
            Members
          </Link>
          <Link
            to="/_/w/$workspace/settings/teams"
            params={params}
            className={TAB}
          >
            Teams
          </Link>
          <Link
            to="/_/w/$workspace/settings/webhooks"
            params={params}
            className={TAB}
          >
            Webhooks
          </Link>
          <Link
            to="/_/w/$workspace/settings/workspace"
            params={params}
            className={TAB}
          >
            Workspace
          </Link>
        </nav>
        <Outlet />
      </main>
    </div>
  )
}
