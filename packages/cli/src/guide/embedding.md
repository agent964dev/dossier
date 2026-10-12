## Embedding

A page framed inside another page gets `data-dossier-embedded` on its
`<html>` before it paints, and Dossier hides nothing. A layout that should drop
its chrome in embeds adds one rule, such as
`html[data-dossier-embedded] .site-header { display: none }`. A folder whose
pages never want the chrome above them (mockups, say) holds a complete-document
`_layout.html` whose body is only `<slot></slot>`, which opts it out of the
outer layouts.
