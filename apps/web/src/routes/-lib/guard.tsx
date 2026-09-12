import { redirect, type ErrorComponentProps } from '@tanstack/react-router'
import { AlertTriangle } from 'lucide-react'

import { Atmosphere } from '../../components/atmosphere'
import { Button } from '../../components/ui/button'
import type { SurfaceFailure } from '../../server/runtime'

export function isSurfaceFailure(value: unknown): value is SurfaceFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === 'string'
  )
}

/**
 * Loader results are `data | SurfaceFailure`. A missing or stale session sends
 * the reader to sign-in with their destination preserved; anything else
 * surfaces as a page-level error rather than a half-rendered dashboard.
 */
export function requireData<T>(result: T | SurfaceFailure, next: string): T {
  if (!isSurfaceFailure(result)) return result
  if (result.code === 'unauthenticated') {
    throw redirect({ to: '/sign-in', search: { next } })
  }
  throw new Error(result.message)
}

export function RouteError({ error }: ErrorComponentProps) {
  return (
    <div className="relative isolate flex min-h-dvh items-center justify-center px-5 py-16">
      <Atmosphere />
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center">
        <span className="inline-flex size-10 items-center justify-center rounded-full border border-destructive/30 bg-destructive/10 text-error-300">
          <AlertTriangle aria-hidden className="size-5" />
        </span>
        <h1 className="font-clash mt-4 text-xl font-semibold tracking-[-0.02em] text-neutral-50">
          This page could not be loaded
        </h1>
        <p className="mt-2 text-sm leading-body text-neutral-400">
          {error instanceof Error ? error.message : 'Unknown error.'}
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button asChild>
            <a href="/dashboard">Back to documents</a>
          </Button>
          <Button asChild variant="outline">
            <a href="/">dossier home</a>
          </Button>
        </div>
      </div>
    </div>
  )
}
