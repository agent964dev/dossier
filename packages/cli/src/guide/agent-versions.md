## Agent versions

Every link returns the page's agent version to an agent: a request with
`Accept: text/markdown`, or one carrying an agent key
(`Authorization: Bearer <key>`), and `dossier read` return the same text.

The agent version is the page's companion when it has one: the file its
`<link rel="alternate" href="…">` names (a relative `href`, no `hreflang` or
`media`, and no `type` or one of `text/markdown`, `text/plain`,
`application/json`), else the `.md` of the same name beside it
(`plan.html` → `plan.md`, `questions/index.html` → `questions/index.md`). A JSON
companion is returned unchanged, so a page can render itself from the same file
through the page client while agents read it. A push warns when the named
companion is not in the tree.

A page without a companion gets Markdown made from it at push: headings,
prose, lists, tables, links, image alt text, inline SVG titles and
descriptions, Mermaid source, code blocks, math as TeX, and each form's
questions with their labels, types and every option, never anyone's answers.
Parts drawn only by script get one line naming them by `title` or
`aria-label`, so give a chart `aria-label="Trucks per region"`. Layouts are
never part of it. Write a companion when a page is mostly script.

Markdown ends with one line that says where else to look, such as
`Data: answers/ (3 files) · Comments: 2`, counting only what the reader can
open. Read those folders with `dossier read`.
