import {
  bellName,
  notificationActor,
  notificationsListOf,
  notificationWhat,
  notificationWhere,
  timeAgo,
  unreadBadge,
  type DossierNotification,
} from '@dossier/contracts/bridge'
import { useRouter } from '@tanstack/react-router'
import { Bell } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'

import { Avatar } from './avatar'

/** How often the unread count is asked again while a screen is open. */
export const REFRESH_MS = 60_000

const API = '/_/api/notifications'

/** One read of the person's notifications; null when it did not come. */
const ask = async (query: Record<string, string>) => {
  try {
    const response = await fetch(`${API}?${new URLSearchParams(query)}`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    return response.ok ? notificationsListOf(await response.json()) : null
  } catch {
    return null
  }
}

/** Marks some read, or all; a link chosen goes on while it is sent. */
const markRead = async (ids: readonly string[] | 'all') => {
  try {
    const response = await fetch(`${API}/read`, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'content-type': 'application/json', 'Dossier-CSRF': '1' },
      body: JSON.stringify(ids === 'all' ? { all: true } : { ids }),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { unread?: unknown }
    return typeof body.unread === 'number' ? body.unread : null
  } catch {
    return null
  }
}

const ACTION =
  'rounded-md px-2 py-1.5 text-xs font-medium text-brand-300 outline-none transition-colors duration-200 ease-agent hover:bg-neutral-800/70 hover:text-brand-200 focus-visible:ring-[3px] focus-visible:ring-ring/50'

/**
 * The bell beside the account chip: the unread count on it ("9+" past
 * nine), and a list of the person's notifications that opens under it,
 * newest first, each a link to its comment. The count is asked again when
 * the screen gets focus and every minute.
 */
export function NotificationBell() {
  const router = useRouter()
  const panelId = useId()
  const titleId = useId()
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<readonly DossierNotification[] | null>(
    null,
  )
  const [next, setNext] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const title = useRef<HTMLHeadingElement>(null)

  const load = useCallback(async (before: string | null) => {
    setBusy(true)
    const page = await ask(
      before === null ? { limit: '20' } : { limit: '20', before },
    )
    setBusy(false)
    if (page === null) {
      setFailed(true)
      return
    }
    setFailed(false)
    setUnread(page.unread)
    setNext(page.next)
    setItems((had) =>
      before === null || had === null
        ? page.notifications
        : [
            ...had,
            ...page.notifications.filter(
              (n) => !had.some((old) => old.id === n.id),
            ),
          ],
    )
  }, [])

  // The count now, when the screen comes back, and every minute.
  useEffect(() => {
    let live = true
    const count = () => {
      void ask({ limit: '0' }).then((page) => {
        if (live && page !== null) setUnread(page.unread)
      })
    }
    count()
    const again = () => {
      if (document.visibilityState !== 'hidden') count()
    }
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    const timer = window.setInterval(again, REFRESH_MS)
    return () => {
      live = false
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
      window.clearInterval(timer)
    }
  }, [])

  const close = useCallback((focus: boolean) => {
    setOpen(false)
    if (focus) button.current?.focus()
  }, [])

  // Escape, or a press anywhere else, closes it.
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(true)
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open, close])

  const toggle = () => {
    if (open) {
      close(true)
      return
    }
    setOpen(true)
    void load(null)
    // Focus moves into the list, so it is read from its title.
    window.requestAnimationFrame(() => title.current?.focus())
  }

  const readAll = async () => {
    setItems((had) => had?.map((n) => ({ ...n, read: true })) ?? had)
    setUnread(0)
    title.current?.focus()
    const left = await markRead('all')
    if (left !== null) setUnread(left)
    // "mentioned you" on the screen behind goes with them.
    void router.invalidate()
  }

  const choose = (n: DossierNotification) => {
    if (n.read) return
    setUnread((was) => Math.max(0, was - 1))
    void markRead([n.id])
  }

  const badge = unreadBadge(unread)
  const anyUnread = unread > 0 || (items?.some((n) => !n.read) ?? false)

  return (
    <div ref={root} className="relative shrink-0 max-sm:static">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        title="Notifications"
        onClick={toggle}
        className="relative flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-neutral-900/60 text-neutral-300 outline-none transition-colors duration-200 ease-agent hover:border-brand-300/45 hover:text-neutral-50 focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-expanded:border-brand-300/45 aria-expanded:text-neutral-50"
      >
        <Bell aria-hidden className="size-4" />
        <span className="sr-only">{bellName(unread)}</span>
        {badge === '' ? null : (
          <span
            aria-hidden
            data-testid="unread-badge"
            className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-mono text-[0.625rem] leading-none font-semibold text-primary-foreground shadow-[0_0_8px_var(--glow-cyan,transparent)]"
          >
            {badge}
          </span>
        )}
      </button>
      <div
        id={panelId}
        role="dialog"
        aria-labelledby={titleId}
        hidden={!open}
        className="absolute top-full right-0 z-30 mt-2 flex max-h-[min(32rem,75dvh)] w-[23rem] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-[0_18px_44px_rgba(0,0,0,0.28)] max-sm:fixed max-sm:inset-x-3 max-sm:top-[4.25rem] max-sm:w-auto"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <h2
            ref={title}
            id={titleId}
            tabIndex={-1}
            className="rounded-sm text-sm font-semibold text-neutral-50 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            Notifications
          </h2>
          {anyUnread ? (
            <button
              type="button"
              onClick={() => void readAll()}
              className={ACTION}
            >
              Mark all as read
            </button>
          ) : null}
        </div>
        <div className="overflow-y-auto overscroll-contain">
          <p
            role="status"
            className="empty:hidden px-3 pt-3 text-sm text-neutral-400"
          >
            {failed
              ? 'Notifications could not load. Try again in a moment.'
              : items === null && busy
                ? 'Loading…'
                : ''}
          </p>
          {items !== null && items.length === 0 && !failed ? (
            <p className="px-3 py-10 text-center text-sm text-neutral-400">
              You're all caught up
            </p>
          ) : null}
          {items === null || items.length === 0 ? null : (
            <ul className="flex flex-col p-1">
              {items.map((n) => (
                <li key={n.id}>
                  <Row notification={n} onChoose={() => choose(n)} />
                </li>
              ))}
            </ul>
          )}
          {next === null || items === null ? null : (
            <div className="border-t border-border p-1">
              <button
                type="button"
                disabled={busy}
                onClick={() => void load(next)}
                className={`${ACTION} w-full py-2 text-center disabled:opacity-60`}
              >
                Show more
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** One notification: who, what, where, its start and when; a link to it. */
function Row({
  notification: n,
  onChoose,
}: {
  notification: DossierNotification
  onChoose: () => void
}) {
  const who = notificationActor(n)
  return (
    <a
      href={n.link}
      onClick={onChoose}
      data-unread={n.read ? undefined : ''}
      className="group relative flex gap-3 rounded-lg px-2.5 py-2.5 outline-none transition-colors duration-200 ease-agent hover:bg-neutral-800/70 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset data-[unread]:bg-brand-300/[0.07]"
    >
      <Avatar
        person={{
          email: n.actor?.email ?? '?',
          name: n.actor?.name ?? (n.actor === null ? 'Someone' : ''),
          image: n.actor?.image ?? null,
        }}
        className="mt-0.5 size-8 rounded-md text-xs"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 pr-3">
        <span className="text-[0.8125rem] leading-snug text-neutral-300">
          {n.read ? null : <span className="sr-only">Unread: </span>}
          <span className="font-medium text-neutral-50">{who}</span>{' '}
          {notificationWhat(n)}
        </span>
        <span dir="auto" className="truncate text-xs text-neutral-400">
          {notificationWhere(n)}
        </span>
        <span
          dir="auto"
          className="line-clamp-2 text-xs leading-relaxed text-neutral-300 [overflow-wrap:anywhere]"
        >
          {n.excerpt}
        </span>
        <time
          dateTime={n.at}
          title={new Date(n.at).toLocaleString()}
          className="font-mono text-[0.6875rem] text-neutral-400"
        >
          {timeAgo(n.at)}
        </time>
      </span>
      {n.read ? null : (
        <span
          aria-hidden
          className="absolute top-3.5 right-2.5 size-2 rounded-full bg-brand-300 shadow-[0_0_6px_currentColor] text-brand-300"
        />
      )}
    </a>
  )
}
