import { Link } from '@tanstack/react-router'

/** The glass header: the wordmark, and the account chip when signed in. */
export function AppHeader({ email }: { email: string | null }) {
  return (
    <header className="px-3 pt-3 sm:px-6 sm:pt-5">
      <div className="chrome-glass mx-auto flex h-12 max-w-3xl items-center justify-between gap-3 rounded-xl px-3.5">
        <Link
          to="/"
          className="font-clash text-[1.0625rem] font-semibold tracking-[-0.02em] text-neutral-50 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-md"
        >
          Dossier
        </Link>
        {email === null ? null : (
          <Link
            to="/_/settings"
            aria-label={`Account settings for ${email}`}
            className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-neutral-900/60 py-1 pr-2.5 pl-1 text-neutral-200 outline-none transition-colors duration-200 ease-agent hover:border-brand-300/45 focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span
              aria-hidden
              className="flex size-6 shrink-0 items-center justify-center rounded-md bg-neutral-700 text-xs font-semibold uppercase text-neutral-100"
            >
              {email.charAt(0)}
            </span>
            <span className="truncate font-mono text-xs">{email}</span>
          </Link>
        )}
      </div>
    </header>
  )
}
