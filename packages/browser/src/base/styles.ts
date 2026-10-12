// How base components and libraries style themselves: one <style> per tag in
// the head, added once, whose every rule starts with :where( so page and kit
// CSS win without !important. They read the tree's theme variables when it
// sets them and otherwise inherit the page's fonts and colours.
import type { BaseComponentTag } from '@dossier/contracts/base'
import type { LibraryName } from '@dossier/html/libraries'

/**
 * Adds `css` for `tag` once per document, at the end of the head. A part of
 * a component with a stylesheet of its own is named `<tag>-<part>`.
 */
export const addBaseStyles = (
  document: Document,
  tag: BaseComponentTag | LibraryName | `${BaseComponentTag}-${string}`,
  css: string,
): void => {
  if (document.querySelector(`style[data-dossier-base="${tag}"]`) !== null) {
    return
  }
  const style = document.createElement('style')
  style.setAttribute('data-dossier-base', tag)
  style.textContent = css
  ;(document.head ?? document.documentElement).appendChild(style)
}

/**
 * Whether the page shows dark at `element`: its computed `color-scheme`
 * names only dark, or names both and the viewer prefers dark.
 */
export const isDark = (window: Window, element: Element): boolean => {
  const scheme = window.getComputedStyle(element).colorScheme ?? ''
  const names = scheme.split(/\s+/)
  if (!names.includes('dark')) return false
  if (!names.includes('light')) return true
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

/** A theme variable's value at `element`, or null when the tree sets none. */
export const themeVariable = (
  window: Window,
  element: Element,
  name: string,
): string | null => {
  const value = window.getComputedStyle(element).getPropertyValue(name).trim()
  return value === '' ? null : value
}
