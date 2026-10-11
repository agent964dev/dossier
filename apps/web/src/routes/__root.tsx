import type { ReactNode } from 'react'
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'

import { PlainError } from '../components/plain-error'
import '../styles/app.css'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'color-scheme', content: 'dark' },
      { name: 'theme-color', content: '#031119' },
      { name: 'referrer', content: 'strict-origin-when-cross-origin' },
      { title: 'Dossier' },
    ],
    links: [
      { rel: 'icon', href: '/_/app/favicon.svg', type: 'image/svg+xml' },
      {
        rel: 'preload',
        href: '/_/app/fonts/ClashDisplay-Variable.woff2',
        as: 'font',
        type: 'font/woff2',
        crossOrigin: 'anonymous',
      },
      {
        rel: 'preload',
        href: '/_/app/fonts/Geist-Variable.woff2',
        as: 'font',
        type: 'font/woff2',
        crossOrigin: 'anonymous',
      },
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
  return (
    // Dark only: the agent964 design language has no light variant.
    <html lang="en" className="dark">
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
