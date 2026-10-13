import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DeploymentSettings } from '../../src/components/deployment-settings'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host as never)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('the account page’s deployment section', () => {
  it('leads a super admin to the deployment’s settings', () => {
    act(() => root.render(<DeploymentSettings superAdmin />))
    const link = host.querySelector('a')
    expect(link?.getAttribute('href')).toBe('/_/admin')
    expect(link?.textContent).toBe('Deployment settings')
    expect(host.querySelector('section')?.getAttribute('aria-labelledby')).toBe(
      'deployment-label',
    )
  })

  it('shows nothing to anyone else', () => {
    act(() => root.render(<DeploymentSettings superAdmin={false} />))
    expect(host.innerHTML).toBe('')
  })
})
