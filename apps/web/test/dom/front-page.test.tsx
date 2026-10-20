import axe from 'axe-core'
import type { ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HomeView } from '../../src/server/home'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// What the home's loader returned, and what its server function answers.
let loaded: HomeView
const homeView = vi.fn<(input: unknown) => Promise<HomeView>>()

// The router's file route keeps its options and hands the screen the loaded
// view; links are plain links; a redirect is the value the loader throws.
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useLoaderData: () => loaded,
  }),
  redirect: (to: { href: string }) => ({ redirectTo: to.href }),
  useNavigate: () => () => Promise.resolve(),
  useRouter: () => ({ invalidate: () => Promise.resolve() }),
  Link: ({
    to,
    children,
    ...rest
  }: {
    to: string
    children: ReactNode
  } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}))
vi.mock('../../src/routes/__root', () => ({
  Route: {
    useLoaderData: () => ({ name: 'Dossier', logo: null, signedIn: null }),
  },
}))
vi.mock('../../src/server/home', () => ({ homeView }))
// A tree's Share opens the share dialog, which is tested on its own.
vi.mock('../../src/server/share-dialog', () => ({
  shareDialogView: () => new Promise(() => {}),
  setShare: () => new Promise(() => {}),
}))

const { Route } = (await import('../../src/routes/index.tsx')) as unknown as {
  Route: {
    options: {
      component: () => ReactNode
      loader: (input: { deps: { w?: string } }) => Promise<HomeView>
    }
  }
}
const HomeScreen = Route.options.component

const view = (over: Partial<HomeView>): HomeView => ({
  deployment: 'dossier.example.com',
  me: null,
  firstRun: false,
  workspaces: [],
  workspace: null,
  trees: [],
  shared: [],
  ...over,
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host as never)
  root = createRoot(host as never)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  homeView.mockReset()
})

const render = (next: HomeView) => {
  loaded = next
  act(() => root.render(<HomeScreen />))
}

const squash = (text: string | null | undefined) =>
  (text ?? '').replace(/\s+/g, ' ').trim()

const linkNamed = (name: string) =>
  [...host.querySelectorAll('a')].find((a) => squash(a.textContent) === name)

describe('the front page', () => {
  it('shows a visitor the landing page: its heading, the way in and the privacy link', () => {
    render(view({}))
    const headings = host.querySelectorAll('h1')
    expect(headings).toHaveLength(1)
    expect(squash(headings[0]?.textContent)).toBe(
      'Your agents write the page. Dossier handles the rest.',
    )
    expect(linkNamed('Sign in')?.getAttribute('href')).toBe('/_/sign-in')
    expect(linkNamed('Privacy')?.getAttribute('href')).toBe('/_/privacy')
    expect(linkNamed('Dossier on GitHub')?.getAttribute('href')).toBe(
      'https://github.com/agent964dev/dossier',
    )
    // The deployment is named, and nothing of the home shows.
    expect(host.textContent).toContain('dossier.example.com')
    expect(host.textContent).not.toContain('Shared with me')
  })

  it('has landmarks, a heading for each section, and named figures', () => {
    render(view({}))
    expect(host.querySelectorAll('header')).toHaveLength(1)
    expect(host.querySelectorAll('main')).toHaveLength(1)
    expect(host.querySelectorAll('footer')).toHaveLength(1)
    for (const section of host.querySelectorAll('main section')) {
      const label = section.getAttribute('aria-labelledby')
      expect(label).toBeTruthy()
      expect(host.querySelector(`#${label}`)?.tagName).toMatch(/^H[12]$/)
    }
    const figures = [...host.querySelectorAll('svg[role="img"]')]
    expect(figures.length).toBeGreaterThanOrEqual(6)
    for (const figure of figures) {
      expect(figure.getAttribute('aria-label')?.length).toBeGreaterThan(40)
    }
    // Every other drawing is an icon, hidden from assistive technology.
    for (const svg of host.querySelectorAll('svg:not([role="img"])')) {
      expect(
        svg.closest('[aria-hidden="true"], svg[role="img"]'),
      ).not.toBeNull()
    }
  })

  it('passes the axe rules that need no layout', async () => {
    render(view({}))
    const results = await axe.run(host as never, {
      runOnly: {
        type: 'rule',
        values: [
          'svg-img-alt',
          'role-img-alt',
          'link-name',
          'button-name',
          'heading-order',
          'empty-heading',
          'list',
          'listitem',
          'landmark-unique',
          'landmark-no-duplicate-banner',
          'landmark-no-duplicate-contentinfo',
          'landmark-one-main',
          'duplicate-id-aria',
          'aria-allowed-attr',
          'aria-hidden-focus',
          'nested-interactive',
        ],
      },
      resultTypes: ['violations'],
    })
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`,
      ),
    ).toEqual([])
  })

  it('still shows a signed-in person their home', () => {
    render(view({ me: { email: 'sara@acme.com', name: 'Sara' } }))
    expect(squash(host.querySelector('h1')?.textContent)).toBe('Shared with me')
    expect(squash(host.textContent)).toContain(
      'Nothing is shared with sara@acme.com',
    )
    expect(host.textContent).not.toContain('Your agents write the page.')
    expect(linkNamed('Sign in')).toBeUndefined()
  })

  it('gives each tree a menu of what the viewer may do on its root', async () => {
    const tree = (name: string, writer: boolean) => ({
      name,
      href: `https://dossier.example.com/acme/${name}/`,
      sharing: { kind: 'private' as const },
      mentioned: false,
      can: { share: writer, history: writer },
      history: writer ? `/_/history/acme/${name}/` : null,
      files: `/_/files/acme/${name}/`,
    })
    render(
      view({
        me: { email: 'sara@acme.com', name: 'Sara' },
        workspace: 'acme',
        workspaces: [
          { name: 'acme', role: 'member', isAdmin: false, suspended: false },
        ],
        trees: [tree('site', true), tree('notes', false)],
      }),
    )
    const menu = (name: string) => {
      const summary = host.querySelector(
        `summary[aria-label="More for ${name}/"]`,
      )
      const items = summary?.parentElement?.querySelectorAll('li > *') ?? []
      return [...items].map((item) => [
        squash(item.textContent),
        item.getAttribute('href'),
      ])
    }
    expect(menu('site')).toEqual([
      ['Share', null],
      ['History', '/_/history/acme/site/'],
      ['Files', '/_/files/acme/site/'],
    ])
    expect(menu('notes')).toEqual([['Files', '/_/files/acme/notes/']])
    // The tree's link and its menu sit side by side, not one inside the other.
    const results = await axe.run(host as never, {
      runOnly: {
        type: 'rule',
        values: ['nested-interactive', 'link-name', 'list', 'listitem'],
      },
      resultTypes: ['violations'],
    })
    expect(results.violations.map((v) => v.id)).toEqual([])
  })

  it("still sends a new deployment's super admin to the first-run settings", async () => {
    homeView.mockResolvedValue(
      view({ me: { email: 'root@example.com', name: '' }, firstRun: true }),
    )
    await expect(Route.options.loader({ deps: {} })).rejects.toEqual({
      redirectTo: '/_/admin',
    })
    const visitor = view({})
    homeView.mockResolvedValue(visitor)
    await expect(Route.options.loader({ deps: {} })).resolves.toBe(visitor)
  })
})
