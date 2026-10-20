import { useState } from 'react'

/** The signed-in person as their sign-in provider last described them. */
export interface SignedInPerson {
  readonly email: string
  /** Empty when the provider gave none. */
  readonly name: string
  /** The address of their profile photo, or null. */
  readonly image: string | null
}

/** What names the person on screen: their name, else their email. */
export const shownName = (person: SignedInPerson): string =>
  person.name.trim() === '' ? person.email : person.name.trim()

/**
 * The person's profile photo, loaded straight from its address without a referrer.
 * The initial of what names them sits underneath, so it shows while the
 * photo loads, when there is none, and when it fails to load.
 */
export function Avatar({
  person,
  className = '',
}: {
  person: SignedInPerson
  className?: string
}) {
  const [failed, setFailed] = useState<string | null>(null)
  const photo = person.image !== null && person.image !== failed
  return (
    <span
      aria-hidden
      className={`relative flex shrink-0 items-center justify-center overflow-hidden bg-neutral-700 font-semibold uppercase text-neutral-100 ${className}`}
    >
      {[...shownName(person)][0] ?? ''}
      {photo ? (
        <img
          src={person.image ?? undefined}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailed(person.image)}
          className="absolute inset-0 size-full object-cover"
        />
      ) : null}
    </span>
  )
}
