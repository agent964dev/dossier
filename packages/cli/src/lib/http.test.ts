import { describe, expect, it, vi } from 'vitest'
import { CliError } from './errors.js'
import { dossierFetch } from './http.js'

describe('dossierFetch', () => {
  it('sends Bearer credentials only to the configured origin', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return Response.json({ authorization: new Headers(init?.headers).get('authorization') })
    }) as unknown as typeof fetch

    const sameOrigin = await dossierFetch(
      'https://dossier.example/api/me',
      { apiUrl: 'https://dossier.example', apiKey: 'ds_secret', fetchImpl },
    )
    expect(await sameOrigin.json()).toEqual({ authorization: 'Bearer ds_secret' })

    const foreignOrigin = await dossierFetch(
      'https://elsewhere.example/public.json',
      { apiUrl: 'https://dossier.example', apiKey: 'ds_secret', fetchImpl },
    )
    expect(await foreignOrigin.json()).toEqual({ authorization: null })
  })

  it('surfaces a useful non-JSON HTTP error', async () => {
    const fetchImpl = vi.fn(async () => new Response('maintenance window', { status: 503 }))
    await expect(
      dossierFetch('/api/me', {
        apiUrl: 'https://dossier.example',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CliError>>({
        message: '503 request failed: maintenance window',
      }),
    )
  })

  it('requires HTTPS except for loopback API origins', async () => {
    await expect(
      dossierFetch('/api/me', {
        apiUrl: 'http://dossier.example',
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CliError>>({
        message: 'API URL must use HTTPS except on loopback: http://dossier.example',
      }),
    )
  })

  it('rejects redirects instead of following them', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://foreign.example/document' },
      }),
    )
    await expect(
      dossierFetch('/d/7k2m9x1qz3ab/raw', {
        apiUrl: 'https://dossier.example',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CliError>>({ message: 'redirects are not allowed' }),
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

})
