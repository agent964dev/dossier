Comment threads on the page, kept beside it: `plan.html` keeps its comments
in `plan.comments/`, one folder per writer, one entry per comment, resolve or
reopen.

    <dossier-comments></dossier-comments>
    <dossier-comments anchors="section[id], figure[id]" pins="img[id]"
      stances="agree, disagree, reopen"></dossier-comments>
    <dossier-comments for="S-108" stances="reopen, for the agent"></dossier-comments>

People comment on the whole page or on an element with an `id`, chosen under
"On". `anchors` is the selector of those elements (default: `section`,
`article`, `figure`, `h1` to `h4`, `li`, `tr`, `img` and `svg` with an `id`).
`pins` is the selector of elements a comment can be pinned to at a point,
such as images and mockups (default: `img`, `svg`, `picture` and
`[data-pins]` with an `id`); a pin is placed by tapping, or with the arrow
keys and Enter. `stances` is a comma-separated list of reactions a new
comment or a reply can carry, such as "reopen" or "for the agent"; there are
none by default, and choosing one is optional.

`for` names the `id` of one element: the element then shows only the threads
on it, and its comments go on it, with no "On" choice and no pins. Put one
under each item to discuss right next to it. It stays folded to a "Comment"
button with its count of open threads until opened. A whole-page element on
the same page still lists every thread, the item's too, and draws the pins;
each comment is stored once.

Threads are ordered by their element's place in the page, whole-page
threads first. A thread whose element is no longer in the page shows under
"On an earlier version". Resolved threads fold away until "Show resolved" is
pressed. Each anchored element carries `data-dossier-comments` with its count
of open threads, so page CSS can mark it. A visitor who comments is asked to
sign in; straight back from that round trip the comment is sent once, and
any later time it waits in its composer for whoever signed in to send.
Unsent text is kept on the device for each person and each item, and for
visitors apart. People who may only read see every thread and no way to
write.

The element fires a bubbling `dossier:state` event with
`{ state: 'saving' | 'saved' | 'failed', error, doc }`, and a bubbling
`dossier:comments` event with `{ threads }` whenever the threads it shows
change: every thread, or with `for` those on its element. Parts:
`.dossier-comments-header`, `.dossier-comments-open` (the folded button),
`.dossier-comments-count`, `.dossier-comments-thread`,
`.dossier-comments-comment`, `.dossier-comments-composer`,
`.dossier-comments-status`, `.dossier-comments-pins`,
`.dossier-comments-pin`; an element with `for` carries
`.dossier-comments-item`.

The component never sends anything to an agent and adds no handoff of its
own; the page decides what its handoff says. Page code reads the threads
with `dossier.read('plan.comments/')` or `dossier.watch`: one Doc per
thread, its `data` a `{ root, replies, resolved }` where each comment has
`by`, `at`, `text`, `anchor`, `stance` and `deleted`. This keeps a handoff of
the open threads up to date, with the page's link:

    dossier.watch('plan.comments/', (threads) => {
      const open = threads.filter((t) => !t.data.resolved)
      // Or only those marked for the agent:
      // .filter((t) => t.data.root.stance === 'for the agent')
      handoff.textContent = [
        `Comments on ${dossier.page.link}`,
        ...open.map(({ data: { root, replies } }) =>
          [root, ...replies]
            .filter((c) => !c.deleted)
            .map((c) => `- ${root.anchor ?? 'page'}: ${c.by}: ${c.text}`)
            .join('\n'),
        ),
      ].join('\n')
    })
