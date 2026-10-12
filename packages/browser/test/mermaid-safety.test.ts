// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest'
import { mermaidConfig, textOnly } from '../src/base/lib/mermaid-safety.ts'

describe('Mermaid’s configuration', () => {
  test('draws every label as SVG text, under the strict security level', () => {
    const config = mermaidConfig({ dark: false, font: null })
    expect(config.securityLevel).toBe('strict')
    expect(config.htmlLabels).toBe(false)
    for (const diagram of ['flowchart', 'class'] as const) {
      expect(config[diagram]?.htmlLabels).toBe(false)
    }
  })

  test('lets no diagram’s directive or frontmatter turn HTML labels back on', () => {
    const { secure } = mermaidConfig({ dark: true, font: 'Inter' })
    // Mermaid's own secure keys stay, and htmlLabels joins them at any depth.
    for (const key of [
      'secure',
      'securityLevel',
      'startOnLoad',
      'maxTextSize',
      'suppressErrorRendering',
      'maxEdges',
      'htmlLabels',
    ]) {
      expect(secure).toContain(key)
    }
  })

  test('follows the page’s scheme and font', () => {
    expect(mermaidConfig({ dark: true, font: 'Inter' })).toMatchObject({
      theme: 'dark',
      fontFamily: 'Inter',
    })
    const light = mermaidConfig({ dark: false, font: null })
    expect(light.theme).toBe('default')
    expect('fontFamily' in light).toBe(false)
  })
})

describe('a rendered diagram, made text only', () => {
  const svg = (inner: string) => {
    const holder = document.createElement('pre')
    holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`
    return holder.querySelector('svg')!
  }

  test('keeps a label’s text and drops links, controls, images and frames', () => {
    const root = svg(
      '<g><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">' +
        '<a href="https://evil.example/x" style="position:fixed">click me</a>' +
        '<input name="x" value="typed"><button>Press</button>' +
        '<select><option>One</option></select><textarea>t</textarea>' +
        '<form action="https://evil.example"><span>in a form</span></form>' +
        '<img src="https://evil.example/i.png"><iframe src="https://evil.example"></iframe>' +
        '<video src="v.mp4"></video><object data="o"></object><embed src="e">' +
        '</div></foreignObject>' +
        '<a href="https://evil.example/node"><text>node</text></a>' +
        '<image href="https://evil.example/i.png"></image></g>',
    )
    textOnly(root)
    expect(
      root.querySelectorAll(
        'a, input, button, select, textarea, form, img, image, iframe, video, object, embed',
      ),
    ).toHaveLength(0)
    expect(root.textContent).toContain('click me')
    expect(root.textContent).toContain('Press')
    expect(root.textContent).toContain('in a form')
    expect(root.textContent).toContain('node')
    expect(root.textContent).not.toContain('typed')
  })

  test('leaves a plain diagram as it is', () => {
    const root = svg(
      '<g><rect width="10" height="10"></rect><text>Start</text></g>',
    )
    const before = root.outerHTML
    textOnly(root)
    expect(root.outerHTML).toBe(before)
  })
})
