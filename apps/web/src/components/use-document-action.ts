import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'

import {
  documentAction,
  type DocumentActionName,
  type DocumentActionResult,
} from '../server/documents'

export interface ActionFailure {
  readonly code: string
  readonly message: string
}

export interface ActionInput {
  readonly id: string
  readonly action: DocumentActionName
  readonly [key: string]: unknown
}

/**
 * Every dashboard mutation goes through the one POST server function, so every
 * caller needs the same three things: which control is busy, what the server
 * said when it refused, and a refreshed page when it agreed. The CSRF token
 * from loader data is attached here so no call site can forget it.
 */
export function useDocumentAction(csrfToken: string) {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  const [failure, setFailure] = useState<ActionFailure | null>(null)

  async function run(
    label: string,
    input: ActionInput,
    { refresh = true }: { refresh?: boolean } = {},
  ): Promise<DocumentActionResult | null> {
    setPending(label)
    setFailure(null)
    let result: DocumentActionResult
    try {
      result = await documentAction({ data: { ...input, csrfToken } })
    } catch (error) {
      setPending(null)
      setFailure({
        code: 'internal',
        message:
          error instanceof Error
            ? error.message
            : 'Something went wrong. Please retry.',
      })
      return null
    }
    if (result.ok !== true) {
      setPending(null)
      setFailure({ code: result.code, message: result.message })
      return null
    }
    if (refresh) await router.invalidate()
    setPending(null)
    return result
  }

  return { pending, failure, setFailure, run }
}
