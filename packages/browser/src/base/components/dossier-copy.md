A button that copies the page's agent version, the text an agent gets from
its link, so a person can hand the page to an agent.

    <dossier-copy></dossier-copy>
    <dossier-copy src="../brief/" label="Copy brief for agent"></dossier-copy>

`src` copies another page or a folder, relative to the page. `label` replaces
"Copy for agent". The status beside the button reads "Copied"; where the
browser refuses the clipboard, the text appears selected for the person to
copy. Parts: `.dossier-copy-button`, `.dossier-copy-status`,
`.dossier-copy-text`.
