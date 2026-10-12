## Layouts

A `_layout.html` wraps every page below it, and the page goes where the
layout's `<slot></slot>` is. Layouts nest: a page sits in its folder's
layout, which sits in the layout above it, outermost first, until one is a
complete document (with a doctype or its own `<html>`). That layout stops the
outer ones, so a complete-document `_layout.html` whose body holds only
`<slot></slot>` opts its folder out of every layout above it. A page that is a
complete document gets no layout. A page that is only a body, with no layout
above it, is placed in the base layer's minimal document. A layout without a
`<slot>` puts the page at the end of its `<body>`.

The heads merge: Dossier writes `<meta charset="utf-8">` first and drops every
other charset meta. Then come each layout's head, outermost first, and the
page's head. `<title>` and each `<meta>` keyed by `name`, `property` or
`http-equiv`: the innermost wins. Stylesheet, preload, modulepreload and icon
links and `<script src>`: kept once per URL, at their first place. Inline
`<style>` and `<script>`: all kept, in order. `<link rel="alternate">` comes
only from the page. `<html>` and `<body>` attributes merge, the innermost
winning, and `class` lists are joined. A push refuses `<base>`.

A layout's relative URLs in `href`, `src`, `srcset`, `poster` and `action` are
rewritten to work from the page's folder. `_` URLs, absolute and root-relative
URLs, query-only and fragment-only URLs and URLs that would leave the tree stay
as written. URLs a layout's script builds at run time are not rewritten, so a script
that loads files should name them with `_` paths.
