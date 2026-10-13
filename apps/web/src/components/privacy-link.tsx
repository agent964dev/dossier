import { Link } from '@tanstack/react-router'

/** The way to the deployment's privacy page, below the front page and sign-in. */
export function PrivacyLink() {
  return (
    <footer className="text-sm text-neutral-400">
      <Link
        to="/_/privacy"
        className="underline underline-offset-4 hover:text-neutral-100"
      >
        Privacy
      </Link>
    </footer>
  )
}
