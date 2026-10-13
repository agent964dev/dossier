A bell with the viewer's notifications in this tree, for a page's or a kit's
own header.

    <header>
      <a href="./">Plans</a>
      <dossier-notifications></dossier-notifications>
    </header>

A person is told when someone mentions them or a team they are in, and when
someone replies in a thread they started or replied in, only for pages they
can open now. Their own comments never tell them anything, and nothing is
sent by email. A page's bell shows only the notifications on pages of its own
tree, which page code could read anyway; the bell in Dossier's own header
shows them across every tree.

The bell's badge counts unread notifications, "9+" past nine, and its name
says the count to screen readers ("Notifications, 3 unread"). Pressing it
opens the list, newest first: who, what ("mentioned you", "mentioned Design",
"replied to your thread"), where (the page's title, and the item's label when
the comment is on one), the comment's start and how long ago. Unread ones are
marked. "Mark all as read" reads this tree's, and "Show more" brings older
ones. With none, it says "You're all caught up". Escape, or pressing
elsewhere, closes the list and gives focus back to the bell. The count is
asked again when the page gets focus and every minute.

Choosing a notification reads it and opens its comment: the link goes to the
page with `#dossier-comment=…`, which `<dossier-comments>` on that page opens
(see its notes). The page client opens it in the shell, as any link to
another page of the tree.

The bell reads through `dossier.notifications` as the viewer, and shows
nothing to a visitor or away from Dossier. Its styles are minimal, read the
theme variables (`--primary`, `--card`, `--border`, `--radius`, `--ring`,
`--muted-foreground`), and any page or kit CSS wins. On a narrow screen the
list spans the width. Parts: `.dossier-notifications-button`,
`.dossier-notifications-badge`, `.dossier-notifications-panel`,
`.dossier-notifications-title`, `.dossier-notifications-mark-all`,
`.dossier-notifications-list`, `.dossier-notifications-item` (with
`data-unread` while unread), `.dossier-notifications-avatar`,
`.dossier-notifications-who`, `.dossier-notifications-agent` (the "Agent"
badge on an agent's comment), `.dossier-notifications-where`,
`.dossier-notifications-excerpt`, `.dossier-notifications-time`,
`.dossier-notifications-empty`, `.dossier-notifications-more`; the element
carries `data-unread` while any are unread.
