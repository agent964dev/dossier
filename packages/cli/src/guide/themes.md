## Themes

A `_theme.css` sets theme variables for everything below it; link it from a
layout or page as `_theme.css` and each page gets the closest one. Dossier
ships no stylesheet for pages, and a tree need not set any variable. Base
components read these names when a tree sets them: the shadcn roles
`--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`,
`--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`,
`--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`,
`--accent-foreground`, `--destructive`, `--destructive-foreground`, `--border`,
`--input`, `--ring` and `--radius`, and the fonts `--font-display`,
`--font-body` and `--font-mono`.

`dossier read <folder>` names the variables the closest `_theme.css` sets.
