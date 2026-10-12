import { createFileRoute, Link } from '@tanstack/react-router'

import { isScreenFailure } from '../../server/failure'
import { privacyView } from '../../server/privacy'

export const Route = createFileRoute('/_/privacy')({
  loader: async () => {
    const view = await privacyView()
    if (isScreenFailure(view)) throw new Error(view.error.message)
    return view
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title:
          loaderData === undefined
            ? 'Privacy'
            : `Privacy · ${loaderData.deployment}`,
      },
    ],
  }),
  component: PrivacyScreen,
})

/**
 * Plain text, as written: its first line is the heading, and the rest keeps
 * its line breaks. Nothing in it is read as markup.
 */
function PrivacyScreen() {
  const view = Route.useLoaderData()
  const [first = '', ...rest] = view.text.split('\n')
  const body = rest.join('\n').trim()
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-6 py-12">
      <Link
        to="/"
        className="w-fit font-mono text-xs break-all text-neutral-400 underline-offset-4 hover:text-neutral-100 hover:underline"
      >
        {view.deployment}
      </Link>
      <h1 className="font-clash text-[1.75rem] leading-[1.1] font-semibold tracking-[-0.03em] break-words text-neutral-50">
        {first}
      </h1>
      {body === '' ? null : (
        <div className="text-[0.9375rem] leading-relaxed break-words whitespace-pre-wrap text-neutral-100">
          {body}
        </div>
      )}
    </main>
  )
}
