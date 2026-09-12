import { describe, expect, it } from 'vitest'
import { CliError, ExitCode, exitCodeFor } from './errors.js'

describe('exit code mapping', () => {
  it('maps success, ordinary failures, usage, and auth', () => {
    expect(ExitCode.Ok).toBe(0)
    expect(exitCodeFor(new Error('boom'))).toBe(1)
    expect(exitCodeFor(new CliError('bad arguments', ExitCode.Usage))).toBe(2)
    expect(exitCodeFor(new CliError('sign in', ExitCode.Auth))).toBe(4)
    expect(exitCodeFor({ status: 401 })).toBe(4)
  })
})
