import { redirect } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import {
  isScreenFailure,
  type ScreenFailure,
} from '../../../../../server/failure'

/** A settings tab's read, or what refused it. */
export type TabRead<A> =
  | { readonly ok: true; readonly view: A }
  | { readonly ok: false; readonly message: string }

/**
 * The layout above a tab renders the no-access page for anyone who is not
 * an admin, so a refused tab only says why in its own place.
 */
export const tabRead = <A,>(
  view: A | ScreenFailure,
  href: string,
): TabRead<A> => {
  if (!isScreenFailure(view)) return { ok: true, view }
  if (view.error.code === 'sign_in_required') {
    throw redirect({ href: `/_/sign-in?next=${encodeURIComponent(href)}` })
  }
  if (view.error.code === 'unavailable') throw new Error(view.error.message)
  return { ok: false, message: view.error.message }
}

/** Renders a tab's view, or what refused it. */
export function Tab<A>({
  read,
  children,
}: {
  read: TabRead<A>
  children: (view: A) => ReactNode
}) {
  return read.ok ? (
    children(read.view)
  ) : (
    <p className="text-[0.9375rem] text-neutral-400">{read.message}</p>
  )
}
