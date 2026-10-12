import { createFileRoute, redirect } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import { AppHeader } from '../../components/app-header'
import {
  SearchField,
  type SearchFieldHandle,
} from '../../components/search-field'
import { isScreenFailure } from '../../server/failure'
import {
  searchView,
  type SearchView,
  type SearchViewResult,
} from '../../server/search'

interface SearchParams {
  readonly q?: string
  readonly offset?: number
}

/** How long typing pauses before the search runs. */
const DEBOUNCE_MS = 200

export const Route = createFileRoute('/_/search')({
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    const offset = Number(search.offset)
    return {
      ...(typeof search.q === 'string' && search.q !== ''
        ? { q: search.q }
        : {}),
      ...(Number.isSafeInteger(offset) && offset > 0 ? { offset } : {}),
    }
  },
  loaderDeps: ({ search }) => ({ q: search.q ?? '', offset: search.offset }),
  loader: async ({ deps, location }): Promise<SearchView> => {
    const view = await searchView({
      data: { q: deps.q, offset: deps.offset ?? 0 },
    })
    if (isScreenFailure(view)) {
      if (view.error.code === 'sign_in_required') {
        throw redirect({
          href: `/_/sign-in?next=${encodeURIComponent(location.href)}`,
        })
      }
      throw new Error(view.error.message)
    }
    return view
  },
  head: () => ({ meta: [{ title: 'Search · Dossier' }] }),
  component: SearchScreen,
})

const countText = (count: number, more: boolean) =>
  `${count}${more ? '+' : ''} ${count === 1 && !more ? 'result' : 'results'}`

function SearchScreen() {
  const view = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const field = useRef<SearchFieldHandle>(null)
  const [text, setText] = useState(search.q ?? '')
  /** The text the address holds, so a search the person typed is not undone. */
  const asked = useRef(search.q ?? '')

  // Back and forward change the address: the field follows it.
  useEffect(() => {
    const q = search.q ?? ''
    if (q !== asked.current) {
      asked.current = q
      setText(q)
    }
  }, [search.q])

  useEffect(() => {
    field.current?.focusEnd()
  }, [])

  // The search runs once typing pauses, replacing the address's text.
  useEffect(() => {
    if (text === asked.current) return
    const timer = setTimeout(() => {
      asked.current = text
      void navigate({
        search: text === '' ? {} : { q: text },
        replace: true,
      })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [text, navigate])

  const showing = text === (search.q ?? '')
  const offset = search.offset ?? 0
  return (
    <div className="min-h-dvh">
      <AppHeader email={view.me.email} label="Search" />
      <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 pt-6 pb-16 sm:px-6">
        <h1 className="sr-only">Search</h1>
        <SearchField
          ref={field}
          id="search"
          value={text}
          onChange={setText}
          onEnter={() => {
            asked.current = text
            void navigate({
              search: text === '' ? {} : { q: text },
              replace: true,
            })
          }}
        />
        <Results view={view} offset={offset} stale={!showing} />
      </main>
    </div>
  )
}

function Results({
  view,
  offset,
  stale,
}: {
  view: SearchView
  offset: number
  stale: boolean
}) {
  const asked = view.results.length > 0 || view.empty !== null
  return (
    <section aria-label="Results" className="flex flex-col gap-3">
      <p role="status" aria-live="polite" className="sr-only">
        {view.problem ??
          (asked ? countText(view.results.length, view.next !== null) : '')}
      </p>
      {view.problem === null ? null : (
        <p className="text-[0.9375rem] text-error-300">{view.problem}</p>
      )}
      {view.empty === null ? null : (
        <p className="rounded-xl border border-border bg-card px-4 py-5 text-[0.9375rem] text-neutral-300">
          {view.empty}
        </p>
      )}
      {view.results.length === 0 ? null : (
        <ul
          role="list"
          className={`divide-y divide-border overflow-hidden rounded-[0.875rem] border border-border bg-card transition-opacity duration-200 ease-agent motion-reduce:transition-none ${stale ? 'opacity-70' : ''}`}
        >
          {view.results.map((result) => (
            <ResultRow key={result.link} result={result} />
          ))}
        </ul>
      )}
      {view.next === null && offset === 0 ? null : (
        <nav aria-label="More results" className="flex gap-3 text-sm">
          {offset === 0 ? null : (
            <a
              href={pageHref(view.input, Math.max(0, offset - 20))}
              className="rounded-md text-brand-200 underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              Earlier results
            </a>
          )}
          {view.next === null ? null : (
            <a
              href={pageHref(view.input, view.next)}
              className="ml-auto rounded-md text-brand-200 underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              More results
            </a>
          )}
        </nav>
      )}
    </section>
  )
}

const pageHref = (q: string, offset: number) =>
  `/_/search?q=${encodeURIComponent(q)}${offset === 0 ? '' : `&offset=${offset}`}`

/** Snippet parts with keys from where each starts in the snippet. */
const keyed = (parts: NonNullable<SearchViewResult['snippet']>) => {
  let at = 0
  return parts.map((part) => {
    const key = `${at}`
    at += part.text.length
    return { key, part }
  })
}

function ResultRow({ result }: { result: SearchViewResult }) {
  return (
    <li>
      <a
        href={result.link}
        className="flex flex-col gap-1 px-3 py-[0.6875rem] outline-none transition-colors duration-200 ease-agent hover:bg-neutral-800/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-4"
      >
        <span
          dir="auto"
          className="text-[0.9375rem] font-medium break-words text-neutral-50"
        >
          {result.title}
          {result.kind === 'page' ? null : (
            <span className="sr-only">
              {result.kind === 'folder' ? ', a folder' : ', a file'}
            </span>
          )}
        </span>
        <span className="font-mono text-[0.6875rem] break-all text-muted-foreground">
          {result.tree}/{result.path}
          {result.kind === 'folder' ? '/' : ''}
        </span>
        {result.snippet === null ? null : (
          <span
            dir="auto"
            className="text-[0.8125rem] leading-[1.45] break-words text-neutral-300"
          >
            {keyed(result.snippet).map(({ key, part }) =>
              part.match ? (
                <mark
                  key={key}
                  className="rounded-[2px] bg-primary/20 px-px text-brand-100 shadow-[inset_0_-1.5px_0_var(--primary)]"
                >
                  {part.text}
                </mark>
              ) : (
                <span key={key}>{part.text}</span>
              ),
            )}
          </span>
        )}
      </a>
    </li>
  )
}
