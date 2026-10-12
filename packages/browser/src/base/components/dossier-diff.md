The changes between two files of the tree, or a unified diff file, with the
code highlighted and the changed words marked.

    <dossier-diff before="v1/plan.md" after="plan.md"></dossier-diff>
    <dossier-diff src="changes.patch"></dossier-diff>

`before`, `after` and `src` are relative to the page. `lang` names the
language when the file extension does not (`lang="markdown"`). `layout` is
`auto` (unified while the element is narrower than 640 px, side by side
otherwise), `split` or `unified`. A file that cannot be loaded, or one over
1 MiB, shows a message in place of the diff. Parts: `.dossier-diff`,
`.dossier-diff-status`, `.dossier-diff-code`; code colours come from the
`--dossier-code-` variables.
