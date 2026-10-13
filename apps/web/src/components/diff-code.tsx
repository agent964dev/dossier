// The code of a diff, rendered by @pierre/diffs with Shiki. This module is
// only ever loaded by diff-view.tsx's effect, so neither library enters the
// server render or the screens' main chunk. The library renders into its own
// shadow root, which keeps the screens' Tailwind out; the colours below read
// the Look's variables, which the shadow root inherits.
import {
  registerCustomTheme,
  type SupportedLanguages,
  type ThemeRegistration,
} from '@pierre/diffs'
import { MultiFileDiff } from '@pierre/diffs/react'
import type { CSSProperties } from 'react'

const THEME = 'dossier-history'

/** Dark code with cyan tags, as the history mocks draw it. */
const theme: ThemeRegistration = {
  name: THEME,
  type: 'dark',
  fg: 'var(--neutral-200)',
  bg: 'var(--neutral-950)',
  colors: {
    'editor.foreground': 'var(--neutral-200)',
    'editor.background': 'var(--neutral-950)',
    'gitDecoration.addedResourceForeground': 'var(--success-400)',
    'gitDecoration.deletedResourceForeground': 'var(--error-400)',
    'gitDecoration.modifiedResourceForeground': 'var(--brand-300)',
  },
  tokenColors: [
    {
      scope: ['comment', 'punctuation.definition.comment'],
      settings: { foreground: 'var(--neutral-400)', fontStyle: 'italic' },
    },
    {
      scope: [
        'punctuation.definition.tag',
        'punctuation.separator',
        'punctuation.terminator',
        'meta.brace',
        'punctuation.section',
      ],
      settings: { foreground: 'var(--neutral-500)' },
    },
    {
      scope: ['entity.name.tag', 'support.class.component'],
      settings: { foreground: 'var(--brand-300)' },
    },
    {
      scope: [
        'entity.other.attribute-name',
        'support.type.property-name',
        'meta.object-literal.key',
      ],
      settings: { foreground: 'var(--accent-300)' },
    },
    {
      scope: ['string', 'markup.inline.raw', 'markup.fenced_code'],
      settings: { foreground: 'var(--complement-300)' },
    },
    {
      scope: [
        'keyword',
        'storage',
        'storage.type',
        'storage.modifier',
        'keyword.control',
      ],
      settings: { foreground: 'var(--accent-300)' },
    },
    {
      scope: [
        'entity.name.function',
        'support.function',
        'meta.function-call',
        'entity.other.attributeName.class',
        'entity.other.attribute-name.class.css',
        'entity.name.tag.css',
      ],
      settings: { foreground: 'var(--brand-200)' },
    },
    {
      scope: [
        'constant',
        'constant.numeric',
        'constant.language',
        'support.constant',
        'keyword.other.unit',
      ],
      settings: { foreground: 'var(--warning-300)' },
    },
    {
      scope: ['markup.heading', 'entity.name.section'],
      settings: { foreground: 'var(--brand-200)', fontStyle: 'bold' },
    },
    {
      scope: ['variable', 'meta.definition.variable'],
      settings: { foreground: 'var(--neutral-100)' },
    },
  ],
}

let registered = false
const useTheme = () => {
  if (registered) return
  registered = true
  registerCustomTheme(THEME, () => Promise.resolve(theme))
}

/**
 * The grammars a history diff loads: these and nothing else, so no other
 * grammar is ever fetched. Anything else shows as plain text.
 */
const LANGUAGES: Readonly<Record<string, SupportedLanguages>> = {
  html: 'html',
  htm: 'html',
  css: 'css',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  webmanifest: 'json',
  md: 'markdown',
  markdown: 'markdown',
}

export const languageOf = (path: string): SupportedLanguages => {
  const dot = path.lastIndexOf('.')
  const extension = dot < 0 ? '' : path.slice(dot + 1).toLowerCase()
  return Object.hasOwn(LANGUAGES, extension)
    ? (LANGUAGES[extension] as SupportedLanguages)
    : 'text'
}

/** Hunk headers in cyan, and the code in the Look's mono face. */
const SHADOW_CSS = `
[data-separator=metadata] { background-color: color-mix(in oklch, var(--brand-400) 7%, var(--neutral-950)); }
[data-separator=metadata] [data-separator-wrapper] {
  color: var(--brand-300);
  background-color: transparent;
  padding-inline: 10px;
  font-family: var(--font-mono, monospace);
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`

export function DiffCode({
  path,
  before,
  after,
  split,
  label,
}: {
  path: string
  before: string | null
  after: string | null
  split: boolean
  label: string
}) {
  useTheme()
  const lang = languageOf(path)
  const file = (contents: string) => ({ name: path, contents, lang })
  const style = {
    '--diffs-font-family': 'var(--font-mono, monospace)',
    '--diffs-header-font-family': 'var(--font-mono, monospace)',
    '--diffs-font-size': '12px',
    '--diffs-line-height': '1.6',
    '--diffs-addition-color-override': 'var(--success-400)',
    '--diffs-deletion-color-override': 'var(--error-400)',
    '--diffs-modified-color-override': 'var(--brand-300)',
    // A changed line mixes 15% of these into the background: about the 10%
    // of the mocks.
    '--diffs-bg-addition-override':
      'color-mix(in oklch, var(--success-400) 65%, var(--neutral-950))',
    '--diffs-bg-deletion-override':
      'color-mix(in oklch, var(--error-400) 75%, var(--neutral-950))',
    '--diffs-bg-addition-emphasis-override':
      'color-mix(in oklch, var(--success-400) 26%, transparent)',
    '--diffs-bg-deletion-emphasis-override':
      'color-mix(in oklch, var(--error-400) 28%, transparent)',
    colorScheme: 'dark',
    display: 'block',
  } as CSSProperties
  const options = {
    theme: THEME,
    themeType: 'dark' as const,
    diffStyle: split ? ('split' as const) : ('unified' as const),
    disableFileHeader: true,
    hunkSeparators: 'metadata' as const,
    overflow: 'wrap' as const,
    lineDiffType: 'word-alt' as const,
    diffIndicators: 'classic' as const,
    unsafeCSS: SHADOW_CSS,
  }
  return (
    <div role="region" aria-label={label} dir="ltr">
      {before === null && after !== null ? (
        <MultiFileDiff
          oldFile={null}
          newFile={file(after)}
          options={options}
          style={style}
          disableWorkerPool
        />
      ) : after === null && before !== null ? (
        <MultiFileDiff
          oldFile={file(before)}
          newFile={null}
          options={options}
          style={style}
          disableWorkerPool
        />
      ) : (
        <MultiFileDiff
          oldFile={file(before ?? '')}
          newFile={file(after ?? '')}
          options={options}
          style={style}
          disableWorkerPool
        />
      )}
    </div>
  )
}
