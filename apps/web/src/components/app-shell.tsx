import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { FileText, KeyRound, LogOut, Trash2, Users } from 'lucide-react'

import { Atmosphere } from './atmosphere'
import { Avatar } from './avatar'
import { BrandMark } from './brand-mark'
import { cn } from '@/lib/utils'
import type { Viewer } from '../server/viewer'

interface NavItem {
  readonly to: string
  readonly label: string
  readonly Icon: typeof FileText
  readonly exact?: boolean
  readonly count?: number
}

/**
 * The one chrome surface (DESIGN.md section 4 — "Chrome family"): glass at the
 * canonical tier, a cyan top-edge hairline as the brand carrier, a neutral
 * border that stays out of the way. Because this is `.glass`, every card below
 * it stays opaque — the two tiers are never stacked in one viewport.
 *
 * On a phone the nav drops to its own scrollable row so the brand and the
 * account chip keep their place; from `md` it sits inline.
 */
export function AppShell({
  viewer,
  subtitle,
  children,
}: {
  viewer: Viewer
  subtitle: string
  children: ReactNode
}) {
  const items: NavItem[] = [
    { to: '/dashboard', label: 'Documents', Icon: FileText, exact: true },
    { to: '/dashboard/trash', label: 'Trash', Icon: Trash2 },
    { to: '/cli/auth', label: 'CLI keys', Icon: KeyRound },
    { to: '/workspace', label: 'Workspace', Icon: Users },
  ]

  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-x-hidden">
      <Atmosphere />

      <div className="sticky top-0 z-20 bg-gradient-to-b from-background via-background/92 to-transparent px-3 pt-3 pb-4 sm:px-5 sm:pt-4">
        <header className="chrome-glass mx-auto w-full max-w-6xl rounded-2xl">
          <div className="flex items-center justify-between gap-3 px-3 py-2.5 sm:px-4 sm:py-3">
            <Link
              to="/dashboard"
              className="group flex min-w-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <BrandMark className="mark-glow size-[22px] shrink-0 text-brand-300" />
              <span className="font-clash text-[1.0625rem] font-semibold tracking-[-0.015em] text-neutral-50">
                dossier
              </span>
              <span className="text-micro-lg hidden truncate border-l border-border pl-2.5 text-neutral-500 sm:inline">
                {subtitle}
              </span>
            </Link>

            <nav aria-label="Sections" className="hidden md:block">
              <ul className="flex items-center gap-0.5">
                {items.map((item) => (
                  <li key={item.to}>
                    <NavLink item={item} />
                  </li>
                ))}
              </ul>
            </nav>

            <div className="flex shrink-0 items-center gap-2">
              <span className="flex items-center gap-2 rounded-lg border border-border bg-neutral-900/50 py-1 pr-2.5 pl-1">
                <Avatar name={viewer.accountName} src={viewer.pictureUrl} className="size-6" />
                <span className="hidden min-w-0 flex-col leading-none lg:flex">
                  <span className="max-w-[11rem] truncate text-xs font-medium text-neutral-200">
                    {viewer.accountName}
                  </span>
                  <span className="text-micro-lg mt-1 text-neutral-500">
                    {viewer.workspaceSlug}
                    {viewer.role ? ` · ${viewer.role}` : ' · no access'}
                  </span>
                </span>
              </span>

              {/*
                Sign-out is a real form post to the Effect handler: state
                changes stay POST-only and Origin-checked, and the control
                keeps working with JavaScript disabled.
              */}
              <form method="post" action="/auth/sign-out">
                <button
                  type="submit"
                  aria-label="Sign out"
                  title="Sign out"
                  className={cn(
                    'inline-flex size-9 items-center justify-center rounded-lg text-neutral-400',
                    'transition-[color,background-color,transform] duration-200 ease-agent',
                    'hover:-translate-y-[2px] hover:bg-neutral-800/70 hover:text-error-300 active:translate-y-[1px]',
                    'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  )}
                >
                  <LogOut aria-hidden className="size-4" />
                </button>
              </form>
            </div>
          </div>

          {/*
            A phone gets a four-up tab bar rather than a scrolling strip: every
            destination stays reachable with one thumb and nothing is clipped
            at 375px.
          */}
          <nav
            aria-label="Sections"
            className="border-t border-border/60 px-1.5 py-1.5 md:hidden"
          >
            <ul className="grid grid-cols-4 gap-0.5">
              {items.map((item) => (
                <li key={item.to}>
                  <NavLink item={item} stacked />
                </li>
              ))}
            </ul>
          </nav>
        </header>
      </div>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pt-2 pb-14 sm:px-6 sm:pb-20">
        {children}
      </main>

      <footer className="mt-auto border-t border-border/70">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-1.5 px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="text-micro-lg text-neutral-500">
            {viewer.workspaceName}
            <span className="text-neutral-700"> / </span>
            {viewer.workspaceKind} workspace
          </p>
          <p className="text-micro-lg text-neutral-500">Cloudflare Workers · D1 · R2</p>
        </div>
      </footer>
    </div>
  )
}

function NavLink({ item, stacked = false }: { item: NavItem; stacked?: boolean }) {
  const { Icon } = item
  return (
    <Link
      to={item.to}
      activeOptions={{ exact: item.exact ?? false }}
      className={cn(
        'group/nav relative rounded-lg font-medium text-neutral-400',
        'transition-colors duration-200 ease-agent',
        'hover:bg-neutral-800/60 hover:text-neutral-100',
        'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'data-[status=active]:bg-brand-300/10 data-[status=active]:text-brand-100',
        stacked
          ? 'flex flex-col items-center gap-1 px-1 py-1.5 text-[0.6875rem]'
          : 'flex items-center gap-1.5 px-2.5 py-1.5 text-[0.8125rem] whitespace-nowrap',
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          'opacity-70 group-data-[status=active]/nav:opacity-100',
          stacked ? 'size-4' : 'size-3.5',
        )}
      />
      {item.label}
    </Link>
  )
}
