import { describe, expect, it } from 'vitest'
import { closingTime, resolveFormAction } from '../src/index.ts'

describe('resolveFormAction', () => {
  it('resolves a folder or a .json file beside the page', () => {
    expect(resolveFormAction('plan.html', 'decisions/')).toEqual({
      target: 'decisions',
      kind: 'folder',
    })
    expect(resolveFormAction('team/plan.html', 'decisions.json')).toEqual({
      target: 'team/decisions.json',
      kind: 'json',
    })
    expect(resolveFormAction('team/q3/plan.html', '../votes/')).toEqual({
      target: 'team/votes',
      kind: 'folder',
    })
    expect(resolveFormAction('team/plan.html', './a/./b/../c/')).toEqual({
      target: 'team/a/c',
      kind: 'folder',
    })
  })

  it('reads `.` and `..` at the end as folders', () => {
    expect(resolveFormAction('team/q3/plan.html', '..')).toEqual({
      target: 'team',
      kind: 'folder',
    })
    expect(resolveFormAction('team/plan.html', '.')).toEqual({
      target: 'team',
      kind: 'folder',
    })
  })

  it('percent-decodes names and drops a query or fragment after the path', () => {
    expect(resolveFormAction('plan.html', 'my%20answers/')).toEqual({
      target: 'my answers',
      kind: 'folder',
    })
    expect(resolveFormAction('plan.html', 'ideas.JSON#top')).toEqual({
      target: 'ideas.JSON',
      kind: 'json',
    })
    expect(resolveFormAction('plan.html', ' answers/?x=1 ')).toEqual({
      target: 'answers',
      kind: 'folder',
    })
  })

  it('refuses actions outside the tree', () => {
    for (const action of [
      'https://example.com/answers/',
      'mailto:sara@acme.com',
      '//example.com/answers/',
      '/answers/',
      '\\answers/',
      '?answer=1',
      '#form',
      '../answers/',
      'a/../../answers.json',
      '%2E%2E/answers/',
    ]) {
      expect(resolveFormAction('plan.html', action)).toEqual({
        problem: 'form_action_outside',
      })
    }
  })

  it('refuses `_` paths and the tree root as authored', () => {
    expect(resolveFormAction('plan.html', '_answers/')).toEqual({
      problem: 'form_action_authored',
    })
    expect(resolveFormAction('plan.html', 'a/%5Fkit/x.json')).toEqual({
      problem: 'form_action_authored',
    })
    expect(resolveFormAction('plan.html', './')).toEqual({
      problem: 'form_action_authored',
    })
    expect(resolveFormAction('team/plan.html', '../')).toEqual({
      problem: 'form_action_authored',
    })
  })

  it('refuses anything that is neither a folder nor a .json file', () => {
    for (const action of ['answers', 'answers.html', 'data.csv']) {
      expect(resolveFormAction('plan.html', action)).toEqual({
        problem: 'form_action_kind',
      })
    }
  })

  it('refuses names no file or folder can have', () => {
    expect(resolveFormAction('plan.html', 'a%2Fb/')).toEqual({
      problem: 'bad_name',
    })
    expect(resolveFormAction('plan.html', 'a%0Ab.json')).toEqual({
      problem: 'bad_name',
    })
  })

  it('leaves an empty action to the caller', () => {
    expect(resolveFormAction('plan.html', '  ')).toEqual({
      problem: 'form_without_action',
    })
  })
})

describe('closingTime', () => {
  it('reads a date and time with Z or an offset', () => {
    expect(closingTime('2026-10-20T18:00+03:00')).toBe(
      Date.UTC(2026, 9, 20, 15, 0),
    )
    expect(closingTime('2026-10-20T18:00:30Z')).toBe(
      Date.UTC(2026, 9, 20, 18, 0, 30),
    )
    expect(closingTime('2026-10-20T18:00-0430')).toBe(
      Date.UTC(2026, 9, 20, 22, 30),
    )
    expect(closingTime('2026-10-20 18:00:00.250z')).toBe(
      Date.UTC(2026, 9, 20, 18, 0, 0, 250),
    )
  })

  it('tells a missing offset from something that is not a date and time', () => {
    expect(closingTime('2026-10-20T18:00')).toBe('no_offset')
    expect(closingTime('2026-10-20')).toBeNull()
    expect(closingTime('next Friday')).toBeNull()
    expect(closingTime('2026-02-30T18:00Z')).toBeNull()
    expect(closingTime('2026-10-20T24:00Z')).toBeNull()
    expect(closingTime('')).toBeNull()
  })
})
