import { createFileRoute, Link } from '@tanstack/react-router'

import { blocksOf } from '../../lib/privacy-text'
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

/** The first line is the page's heading; the rest is read as blocks. */
function PrivacyScreen() {
  const view = Route.useLoaderData()
  const [first = '', ...rest] = view.text.split('\n')
  const blocks = blocksOf(rest.join('\n'))
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
      <div className="flex flex-col gap-4 text-[0.9375rem] leading-relaxed break-words text-neutral-100">
        {blocks.map((block, index) =>
          block.kind === 'heading' ? (
            // The blocks are the text as written, in order.
            // oxlint-disable-next-line react/no-array-index-key
            <h2 key={index} className="pt-2 font-semibold text-neutral-50">
              {block.text}
            </h2>
          ) : block.kind === 'list' ? (
            // oxlint-disable-next-line react/no-array-index-key
            <ul key={index} className="flex list-disc flex-col gap-2 pl-5">
              {block.items.map((item, at) => (
                // oxlint-disable-next-line react/no-array-index-key
                <li key={at}>{item}</li>
              ))}
            </ul>
          ) : (
            // oxlint-disable-next-line react/no-array-index-key
            <p key={index} className="whitespace-pre-wrap">
              {block.text}
            </p>
          ),
        )}
      </div>
    </main>
  )
}
