import { describe, expect, it } from 'vitest'

import {
  commentsFolderIn,
  commentsFolderOf,
  isThreadMark,
  pageOfCommentsFolder,
} from './comments.ts'

describe('comments folders', () => {
  it('names a page’s comments folder beside it, and the page back from it', () => {
    expect(commentsFolderOf('a/plan.html')).toBe('a/plan.comments/')
    expect(commentsFolderOf('q/index.html')).toBe('q/index.comments/')
    expect(commentsFolderOf('plan.html')).toBe('plan.comments/')
    expect(pageOfCommentsFolder('a/plan.comments/')).toBe('a/plan.html')
    expect(pageOfCommentsFolder('q/index.comments')).toBe('q/index.html')
    expect(pageOfCommentsFolder('a/plan/')).toBeNull()
    expect(pageOfCommentsFolder('.comments/')).toBeNull()
    for (const page of ['plan.html', 'a/b/c.html', 'q/index.html']) {
      expect(pageOfCommentsFolder(commentsFolderOf(page))).toBe(page)
    }
  })

  it('finds the comments folder a path lies in', () => {
    expect(commentsFolderIn('a/plan.comments/sara@acme.com/x.json')).toBe(
      'a/plan.comments',
    )
    expect(commentsFolderIn('plan.comments/')).toBe('plan.comments')
    expect(commentsFolderIn('a/answers/x.json')).toBeNull()
  })

  it('tells a resolve or reopen from a comment', () => {
    expect(isThreadMark({ resolves: 'plan.comments/a@b.c/x.json' })).toBe(true)
    expect(isThreadMark({ reopens: 'plan.comments/a@b.c/x.json' })).toBe(true)
    expect(isThreadMark({ resolves: 'x', text: 'y' })).toBe(false)
    expect(isThreadMark({ text: 'y' })).toBe(false)
  })
})
