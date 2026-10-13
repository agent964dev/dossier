// Theme variables: the names base components read when a tree's
// `_theme.css` sets them. Dossier sets none itself; a page looks the way its
// author makes it.

/** The shadcn-compatible role names, then the three font roles. */
export const THEME_VARIABLES: readonly string[] = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--destructive-foreground',
  '--border',
  '--input',
  '--ring',
  '--radius',
  '--font-display',
  '--font-body',
  '--font-mono',
]

/** Comments and strings, which can hold text that looks like a declaration. */
const NOT_CODE =
  /\/\*[\s\S]*?(?:\*\/|$)|"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'/g

/** A custom property declared: after `{` or `;`, its name, then `:`. */
const DECLARED = /(?:^|[{;])\s*(--[A-Za-z0-9_\-\u0080-￿]+)\s*:/g

/** The custom properties a stylesheet declares, sorted, once each. */
export const themeVariables = (css: string): readonly string[] => {
  const code = css.replace(NOT_CODE, (match) =>
    match.startsWith('/*') ? ' ' : '""',
  )
  const names = new Set<string>()
  for (const match of code.matchAll(DECLARED)) {
    if (match[1] !== undefined) names.add(match[1])
  }
  return [...names].sort()
}
