import { Link } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import type { ReactNode } from 'react'

import { Route as Root } from '../routes/__root'
import { Avatar, shownName, type SignedInPerson } from './avatar'
import { NotificationBell } from './notification-bell'

/** The deployment's name and logo, as the Look sets them. */
export interface HeaderBrand {
  readonly name: string
  /** The logo's URL, or null when the name stands alone. */
  readonly logo: string | null
}

/**
 * The glass header: the Look's logo and name, an optional control beside
 * it (the workspace menu on the home), and when signed in search, the
 * notification bell and the account chip.
 * `brand` stands in for the saved Look, as the Look screen's preview does.
 */
export function AppHeader({
  email,
  beside,
  label,
  brand,
}: {
  email: string | null
  beside?: ReactNode
  /** A mono micro-label after the name, such as "History"; wider screens only. */
  label?: string
  brand?: HeaderBrand
}) {
  const saved = Root.useLoaderData() as
    | (HeaderBrand & { readonly signedIn: SignedInPerson | null })
    | undefined
  const { name, logo } = brand ?? saved ?? { name: 'Dossier', logo: null }
  // The screen says whether the chip shows; the root knows the person's name
  // and photo, used only while it is the same person.
  const signedIn = saved?.signedIn ?? null
  const person = signedIn?.email === email ? signedIn : null
  return (
    <header className="px-3 pt-3 sm:px-6 sm:pt-5">
      <div className="chrome-glass mx-auto flex h-12 max-w-3xl items-center justify-between gap-3 rounded-xl px-3.5">
        <div className="flex min-w-0 shrink-0 items-center gap-2 max-sm:max-w-[70%]">
          <Link
            to="/"
            className="flex min-w-0 shrink-0 items-center gap-2 rounded-md font-clash text-[1.0625rem] font-semibold tracking-[-0.02em] text-neutral-50 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {logo === null ? null : (
              <img
                src={logo}
                alt=""
                className="h-6 w-auto max-w-24 shrink-0 object-contain"
              />
            )}
            <span className="truncate">{name}</span>
          </Link>
          {label === undefined ? null : (
            <span className="ml-1.5 font-mono text-[0.6875rem] tracking-[0.2em] whitespace-nowrap text-neutral-400 uppercase max-sm:hidden">
              {label}
            </span>
          )}
          {beside === undefined ? null : (
            <>
              <span aria-hidden className="text-neutral-600">
                /
              </span>
              {beside}
            </>
          )}
        </div>
        {email === null ? null : (
          <div className="flex min-w-0 items-center gap-2">
            <Link
              to="/_/search"
              aria-label="Search"
              title="Search"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-neutral-900/60 text-neutral-300 outline-none transition-colors duration-200 ease-agent hover:border-brand-300/45 hover:text-neutral-50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Search aria-hidden className="size-4" />
            </Link>
            <NotificationBell />
            <Account
              person={person ?? { email, name: '', image: null }}
              narrow={beside !== undefined}
            />
          </div>
        )}
      </div>
    </header>
  )
}

/**
 * The account chip, to account settings: the person's Google photo and name,
 * else the initial and the email. Beside another control, phones show the
 * photo or initial alone.
 */
function Account({
  person,
  narrow,
}: {
  person: SignedInPerson
  narrow: boolean
}) {
  const named = person.name.trim() !== ''
  return (
    // Named by what it shows, so people who speak to their device can say
    // it: the name or email, after words only screen readers read.
    <Link
      to="/_/settings"
      className={`flex min-w-0 items-center gap-2 rounded-lg border border-border bg-neutral-900/60 py-1 pr-2.5 pl-1 text-neutral-200 outline-none transition-colors duration-200 ease-agent hover:border-brand-300/45 focus-visible:ring-[3px] focus-visible:ring-ring/50 ${narrow ? 'max-sm:pr-1' : ''}`}
    >
      <Avatar person={person} className="size-6 rounded-md text-xs" />
      <span className="sr-only">Account settings, </span>
      <span
        className={`truncate ${named ? 'text-[0.8125rem] font-medium' : 'font-mono text-xs'} ${narrow ? 'max-sm:sr-only' : ''}`}
      >
        {shownName(person)}
      </span>
    </Link>
  )
}
