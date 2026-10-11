import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  isNodeName,
  isTreeName,
  isWorkspaceName,
  linkFor,
  parseTarget,
  TreeName,
  WorkspaceName,
} from './index.ts'

const origin = new URL('https://dossier.agent964.com')

describe('names', () => {
  it('takes lowercase letters, digits and hyphens, never api or cli for a workspace', () => {
    for (const name of ['agent964', 'a', 'acme-2', 'x'.repeat(63)]) {
      expect(isWorkspaceName(name), name).toBe(true)
      expect(isTreeName(name), name).toBe(true)
    }
    for (const name of ['', '-a', 'A', 'a_b', 'a.b', 'x'.repeat(64), '_']) {
      expect(isWorkspaceName(name), name).toBe(false)
      expect(isTreeName(name), name).toBe(false)
    }
    expect(isWorkspaceName('api')).toBe(false)
    expect(isWorkspaceName('cli')).toBe(false)
    expect(isTreeName('api')).toBe(true)
    expect(Schema.is(WorkspaceName)('cli')).toBe(false)
    expect(Schema.is(TreeName)('cli')).toBe(true)
  })

  it('refuses node names that are empty, dots, slashes, control characters or too long', () => {
    for (const name of [
      '',
      '.',
      '..',
      'a/b',
      'a\u0000',
      'a\nb',
      'é'.repeat(128),
    ]) {
      expect(isNodeName(name), JSON.stringify(name)).toBe(false)
    }
    for (const name of [
      '_theme.css',
      'index.html',
      'تقرير.html',
      '.env',
      'é'.repeat(127),
    ]) {
      expect(isNodeName(name), name).toBe(true)
    }
  })
})

describe('parseTarget', () => {
  it('reads paths and links on this deployment', () => {
    expect(parseTarget('agent964/acme/questions', origin)).toEqual({
      workspace: 'agent964',
      tree: 'acme',
      path: 'questions',
      folder: false,
    })
    expect(parseTarget('agent964/acme/', origin)).toEqual({
      workspace: 'agent964',
      tree: 'acme',
      path: '',
      folder: true,
    })
    expect(parseTarget('agent964/acme', origin)?.folder).toBe(true)
    expect(
      parseTarget('https://dossier.agent964.com/agent964/acme/a%20b/', origin),
    ).toEqual({
      workspace: 'agent964',
      tree: 'acme',
      path: 'a b',
      folder: true,
    })
  })

  it('refuses other hosts, bad names and climbing segments', () => {
    for (const input of [
      'https://elsewhere.com/agent964/acme/',
      'agent964',
      'api/acme',
      'agent964/acme/../x',
      'agent964/acme//x',
      '_/settings',
    ]) {
      expect(parseTarget(input, origin), input).toBeNull()
    }
  })
})

describe('linkFor', () => {
  const at = (path: string, kind: 'page' | 'folder' | 'file') =>
    linkFor(origin, { workspace: 'agent964', tree: 'acme', path, kind })

  it('writes every kind of link', () => {
    expect(at('a/b.html', 'page')).toBe(
      'https://dossier.agent964.com/agent964/acme/a/b',
    )
    expect(at('a/index.html', 'page')).toBe(
      'https://dossier.agent964.com/agent964/acme/a/',
    )
    expect(at('index.html', 'page')).toBe(
      'https://dossier.agent964.com/agent964/acme/',
    )
    expect(at('a', 'folder')).toBe(
      'https://dossier.agent964.com/agent964/acme/a/',
    )
    expect(at('', 'folder')).toBe('https://dossier.agent964.com/agent964/acme/')
    expect(at('logo.svg', 'file')).toBe(
      'https://dossier.agent964.com/agent964/acme/logo.svg',
    )
    expect(at('a b/c#d.txt', 'file')).toBe(
      'https://dossier.agent964.com/agent964/acme/a%20b/c%23d.txt',
    )
  })
})
