import * as contracts from '@dossier/contracts'
import * as html from '@dossier/html'
import { describe, expect, it } from 'vitest'

// @dossier/html keeps its own copy of the path rules; the two must agree.
describe('the path rules of @dossier/contracts and @dossier/html', () => {
  it('agree on the deepest a node may sit', () => {
    expect(html.MAX_DEPTH).toBe(contracts.MAX_DEPTH)
  })

  it.each([
    'index.html',
    '_theme.css',
    '_components',
    'plans',
    'q3 plan.html',
    'résumé.html',
    '日本語.html',
    '.dossierignore',
    '...',
    '',
    '.',
    '..',
    'a/b',
    'nul\u0000',
    'tab\there',
    'del\u007f',
    'x'.repeat(255),
    'x'.repeat(256),
    'é'.repeat(127),
    'é'.repeat(128),
  ])('agree on whether %j is a node name', (name) => {
    expect(html.isNodeName(name)).toBe(contracts.isNodeName(name))
  })
})
