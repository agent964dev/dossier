// The viewer's clock in these tests: three hours ahead of UTC.
process.env.TZ = 'Asia/Baghdad'

import { act } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'

import { LocalTime } from '../../src/components/local-time.tsx'
import { timeText } from '../../src/lib/times.ts'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// 12 Oct 2026, 16:10 UTC: 19:10 in Baghdad.
const AT = Date.UTC(2026, 9, 12, 16, 10)
// 23:30 UTC on 12 Oct is already 13 Oct in Baghdad.
const LATE = Date.UTC(2026, 9, 12, 23, 30)

let host: HTMLDivElement

afterEach(() => host?.remove())

const shown = (text: string) => text.replace(/\s+/g, ' ').trim()

describe('times on the screens', () => {
  it('are written on the viewer’s clock', () => {
    expect(timeText(AT, 'when')).toBe('12 Oct, 19:10')
    expect(timeText(LATE, 'day')).toBe('13 Oct')
    expect(timeText(AT, 'when', 'UTC')).toBe('12 Oct, 16:10')
    expect(timeText(Date.UTC(2025, 2, 3), 'day-or-year', 'UTC', AT)).toBe(
      '3 Mar 2025',
    )
    expect(timeText(AT, 'day-or-year', 'UTC', AT)).toBe('12 Oct')
  })

  it('say UTC on the server, then show the viewer’s own time once loaded', async () => {
    const html = renderToString(<LocalTime at={AT} format="when" />)
    expect(html).toContain('12 Oct, 16:10 UTC')
    expect(html).toContain(`dateTime="${new Date(AT).toISOString()}"`)

    host = document.createElement('div')
    host.innerHTML = html
    document.body.append(host as never)
    await act(async () => {
      hydrateRoot(host as never, <LocalTime at={AT} format="when" />)
    })
    expect(shown(host.textContent ?? '')).toBe('12 Oct, 19:10')
  })

  it('show a day on the viewer’s clock when rendered in the browser', async () => {
    host = document.createElement('div')
    document.body.append(host as never)
    const root = createRoot(host as never)
    await act(async () => {
      root.render(<LocalTime at={new Date(LATE).toISOString()} format="day" />)
    })
    expect(shown(host.textContent ?? '')).toBe('13 Oct')
    act(() => root.unmount())
  })
})
