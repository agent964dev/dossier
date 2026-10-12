Comment threads on the page, kept beside it: `plan.html` keeps its comments
in `plan.comments/`, one folder per writer, one entry per comment, resolve or
reopen.

    <dossier-comments></dossier-comments>
    <dossier-comments anchors="section[id], figure[id]" pins="img[id]"
      stances="agree, disagree, reopen"></dossier-comments>

People comment on the whole page or on an element with an `id`, chosen under
"On". `anchors` is the selector of those elements (default: `section`,
`article`, `figure`, `h1` to `h4`, `li`, `tr`, `img` and `svg` with an `id`).
`pins` is the selector of elements a comment can be pinned to at a point,
such as images and mockups (default: `img`, `svg`, `picture` and
`[data-pins]` with an `id`); a pin is placed by tapping, or with the arrow
keys and Enter. `stances` is a comma-separated list of reactions a reply can
carry; there are none by default.

Threads are ordered by their element's place in the page, whole-page
threads first. A thread whose element is no longer in the page shows under
"On an earlier version". Resolved threads fold away until "Show resolved" is
pressed. Each anchored element carries `data-dossier-comments` with its count
of open threads, so page CSS can mark it. A visitor who comments is asked to
sign in, and the comment is sent once they are back. People who may only
read see every thread and no way to write.

The element fires a bubbling `dossier:state` event with
`{ state: 'saving' | 'saved' | 'failed', error, doc }`. Parts:
`.dossier-comments-header`, `.dossier-comments-thread`,
`.dossier-comments-comment`, `.dossier-comments-composer`,
`.dossier-comments-status`, `.dossier-comments-pins`,
`.dossier-comments-pin`.
