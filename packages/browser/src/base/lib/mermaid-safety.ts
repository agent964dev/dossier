// What keeps a Mermaid diagram a picture: every label is drawn as SVG text,
// no directive or frontmatter in a diagram can turn HTML labels back on, and
// whatever a diagram type still renders as markup loses its links, controls,
// images and frames, keeping only its text.

/** Mermaid's own keys a diagram may never change, and HTML labels at any depth. */
const SECURE = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  'htmlLabels',
]

export interface MermaidSafeConfig {
  readonly startOnLoad: false
  readonly securityLevel: 'strict'
  readonly theme: 'dark' | 'default'
  readonly fontFamily?: string
  readonly htmlLabels: false
  readonly flowchart: { readonly htmlLabels: false }
  readonly class: { readonly htmlLabels: false }
  readonly secure: string[]
}

export const mermaidConfig = (page: {
  readonly dark: boolean
  readonly font: string | null
}): MermaidSafeConfig => ({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: page.dark ? 'dark' : 'default',
  ...(page.font === null ? {} : { fontFamily: page.font }),
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  class: { htmlLabels: false },
  secure: [...SECURE],
})

/** Elements whose text stays, without the element. */
const UNWRAPPED = 'a, button, form, label'
/** Elements that go with everything in them. */
const REMOVED =
  'input, select, textarea, img, image, iframe, frame, object, embed, video, audio, source, track'

/** Leaves only drawing and text in a rendered diagram. */
export const textOnly = (svg: Element): void => {
  for (const element of svg.querySelectorAll(REMOVED)) element.remove()
  for (const element of [...svg.querySelectorAll(UNWRAPPED)].reverse()) {
    element.replaceWith(...element.childNodes)
  }
}
