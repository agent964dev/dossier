import { Button } from './ui/button'

/** "Something went wrong": no stack trace, one way forward. */
export function PlainError() {
  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-xl font-semibold text-neutral-50">
          Something went wrong. Try again.
        </h1>
        <Button onClick={() => window.location.reload()}>Try again</Button>
      </div>
    </main>
  )
}
