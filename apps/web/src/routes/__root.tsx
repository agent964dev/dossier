import type { ReactNode } from 'react'
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'

import { PlainError } from '../components/plain-error'
import { currentLookVersion, type CurrentLook } from '../server/look'
import '../styles/app.css'

export const Route = createRootRoute({
  // The Look changes only when a super admin saves it, and the Look screen
  // loads a new document after a save, so a loaded document keeps this.
  loader: (): Promise<CurrentLook> => currentLookVersion(),
  staleTime: Number.POSITIVE_INFINITY,
  head: ({ loaderData }) => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'color-scheme', content: loaderData?.scheme ?? 'dark' },
      { name: 'theme-color', content: loaderData?.themeColor ?? '#031119' },
      { name: 'referrer', content: 'strict-origin-when-cross-origin' },
      { title: loaderData?.name ?? 'Dossier' },
    ],
    links: [
      { rel: 'icon', href: '/_/app/favicon.svg', type: 'image/svg+xml' },
      // The deployment's Look: every design token and font face, after
      // app.css, which only names them.
      ...(loaderData === undefined
        ? []
        : [
            {
              rel: 'stylesheet',
              href: `/_/look/${loaderData.version}.css`,
            },
          ]),
      ...(loaderData?.preload ?? []).map((href) => ({
        rel: 'preload',
        href,
        as: 'font',
        type: 'font/woff2',
        crossOrigin: 'anonymous' as const,
      })),
    ],
  }),
  component: RootComponent,
  errorComponent: () => (
    <RootDocument>
      <PlainError />
    </RootDocument>
  ),
  notFoundComponent: NotFound,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-6 text-center">
      <div className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold text-neutral-50">
          This page does not exist, or you cannot open it.
        </h1>
        <a
          href="/"
          className="text-brand-300 underline-offset-4 hover:underline"
        >
          Go home
        </a>
      </div>
    </main>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  const look = Route.useLoaderData({
    select: (data: CurrentLook | undefined) => data?.scheme,
  })
  return (
    // agent964's Look is dark; a deployment's Look may be light.
    <html lang="en" className={look === 'light' ? 'light' : 'dark'}>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  )
}
