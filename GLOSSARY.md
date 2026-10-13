# Dossier

Dossier hosts the pages agents make: plain HTML in folder trees that share their look and code, keep what people enter, and give agents a readable version of every page. These are the words the product, its interface and its CLI use.

## Language

### People and access

**Agent**:
A coding or product agent acting through the CLI or plain HTTP with a person's agent key. Pushes, pulls, reads and watches.
_Avoid_: bot, AI

**Guest**:
A person signed in with Google who is not a member of the workspace that holds a node. Sees only what is shared with them there. The same person can be a member of their own workspace and a guest in another.
_Avoid_: customer (a guest's relationship to the owner, not a product role), external user, viewer

**Member**:
A person who belongs to a workspace. Can push, and sees what is shared with the workspace, their teams or them.
_Avoid_: team member, user, collaborator

**Admin**:
A member who manages a workspace: its members, teams and settings. The person who creates a workspace is its first admin.
_Avoid_: owner (as a role), superuser

**Super admin**:
A person who runs a whole deployment: decides who may create workspaces, sets limits, suspends abused workspaces, permanently purges deleted content, and names other super admins. Super admin powers never open a workspace's pages or data; a super admin sees content only through the same shares and public links as anyone else. The first super admins are set when the deployment is configured.
_Avoid_: operator, root, superuser; and admin alone, which means a workspace admin

**Visitor**:
Anyone who opens a link without being signed in. A public page opens for them; any other link asks them to sign in first.
_Avoid_: anonymous user, public user

**Respondent**:
Someone holding the respond role on a node.
_Avoid_: participant

**Team**:
A named group of members inside a workspace. A node can be shared with a team. A member can belong to several teams.
_Avoid_: group, squad; and "team" as a visibility level (today's meaning)

**Workspace**:
A group of people that holds several trees, the way an organisation does in Linear. It has members, admins and teams. Workspace names are unique within a deployment.
_Avoid_: organisation, tenant, account, domain

**Deployment**:
One running copy of Dossier on its own domain, with its own workspaces and settings, run by its super admins. dossier.agent964.com is the owner's deployment.
_Avoid_: instance, installation, server, host

**Look**:
How Dossier's own screens look on a deployment: the name in the header, a logo, a palette behind the colour roles, fonts per role and the corner radius. Super admins set it; pages never receive it. agent964's design language is the Look every deployment starts with.
_Avoid_: theme (a tree's `_theme.css`), branding, skin

**Role**:
What a person may do on a node: read, respond or write. A role given on a node applies to everything below it; a lower node cannot narrow it. When several shares reach a person, every role they give adds up: read on a folder and respond on a page inside it give both.
_Avoid_: permission level, visibility

**Share**:
A grant of a role on a node to a person (by email), a team, or the whole workspace. Includes everything in the node; a public share excludes people's data except comments.
_Avoid_: invite, visibility, grant (today's saved-value grants)

**Public**:
A node shared with anyone. Anyone can open it without signing in, along with every file its pages need to render. By default anyone may also respond after signing in with Google; the sharer can choose read only, or, rarely, write.
_Avoid_: unlisted, open, world-readable

**Agent key**:
A credential the CLI or plain HTTP uses to act as its person, optionally limited to one tree or node and to read only.
_Avoid_: API key, token (in product text)

### The tree

**Tree**:
A separate root of folders and files inside a workspace. `_` files, layouts and sharing stop at its top and never reach another tree; trees relate only through links. A tree can be pulled, pushed, shared, moved to another workspace or deleted as a whole.
_Avoid_: hub, drive, project (a project can be any node inside a tree)

**Node**:
Any folder or file in the tree. A project is simply a node.
_Avoid_: project (as a product concept), document

**Page**:
An `.html` file, or a folder that contains `index.html`. What a person opens.
_Avoid_: document, artifact (as a stored thing), doc

**Attachment**:
Any file that is not a page: image, video, data file, download.
_Avoid_: asset (today's workspace-wide CSS and font files)

**Authored file**:
A file created by a push.
_Avoid_: source file, content file

**`_` file**:
A file or folder whose name starts with `_`. Inherited by everything below it and never listed as a page.
_Avoid_: asset, include, partial

**Kit**:
Every `_` file available at a point in the tree, including the base layer.
_Avoid_: design system (the look a kit may carry), template, catalogue

**Base layer**:
Dossier's built-in kit, conceptually above every tree. Any folder can override any part of it.
_Avoid_: runtime, framework

**Layout**:
A `_layout.html` that wraps every page below it; the page goes where `<slot>` is. Layouts nest, outermost first, until one is a complete document.
_Avoid_: template, shell, wrapper

**Theme**:
A `_theme.css` that sets the base layer's theme variables for everything below it.
_Avoid_: brand, skin, tokens (as a user-facing word)

**Component**:
A custom element defined by `_components/<tag>.js`, loaded automatically when a page uses its tag.
_Avoid_: widget, block, plugin

**Push**:
One change that publishes a local folder to a node, all at once, with an optional message.
_Avoid_: upload, deploy, version (today's per-document word)

**Retention period**:
How long deleted files and data stay restorable from history before they are purged. Set per deployment by super admins; 30 days to start.
_Avoid_: trash period, grace period

### Serving

**Composed page**:
The HTML Dossier serves for a page at the moment it is opened: the page placed in its layouts at `<slot>`, with their heads merged, and the kit references it uses resolved. Nothing is stored; it is rebuilt or taken from cache on each request.
_Avoid_: rendered page, build, output

**Shell**:
The first-party Dossier document served at a page's link. It holds the viewer's session, frames the composed page full screen, adds nothing visible, and carries out the page client's requests.
_Avoid_: wrapper (today's word for the saved-values version), host page, chrome; and layout, which is author HTML

**View handle**:
A random token in the path of every frame URL (`/_/v/<handle>/<seq>/...`) that lets a page load its tree's private files as one viewer. Bound to one browser session and one tree, checked with the viewer's current role on every request, renewed by the shell, never a credential for the API.
_Avoid_: ticket (today's 60-second frame token), capability, token

**Blob**:
The stored bytes of one file version, kept once in R2 under their SHA-256 (`blobs/<sha256>`) and shared by every version with the same content.
_Avoid_: asset, object, file (a file is a node)

**Tree hub**:
The Durable Object, one per tree, that keeps live connections from shells and agents and relays "this tree changed" hints to them. It holds no records.
_Avoid_: tree store, room, channel

### Data and forms

**Data file**:
A file written by a form or the page client, owned by the person who wrote it.
_Avoid_: saved values, state, response file

**Submission**:
A data file one person writes through a form.
_Avoid_: response, answer (fine in prose, not as the term)

**Shared file**:
A data file many people edit, such as a form that targets one `.json` file.
_Avoid_: shared state, saved values

**Entry**:
One of several data files a person adds through a form marked `data-entries="many"`, kept in that person's own folder. Each can be revised or withdrawn by its writer.
_Avoid_: row, record, item

**Withdraw**:
To delete one's own submission or entry with all its revisions, leaving only a line in history that it was withdrawn.
_Avoid_: retract, unsubmit

**Draft**:
Unsent edits in a form, kept in the person's browser until sent.
_Avoid_: autosave, saved values

**Page client**:
The small script every page gets (`dossier.read`, `watch`, `write`, `withdraw`, `upload`, `mentionable`, `notifications`, `me`) that acts with the viewer's permissions.
_Avoid_: SDK, runtime, frame runtime

### Comments

**Anchor**:
The element `id` a comment refers to.
_Avoid_: target; and pin, which is a comment on a point of an image

**Stance**:
An optional reaction attached to a comment, such as "reopen", with choices the page sets.
_Avoid_: reaction, vote, status

**Thread**:
A comment with its replies. A thread can be resolved and reopened.
_Avoid_: conversation, discussion

**Pin**:
A comment placed at a point on an image or mockup instead of on an element `id`.
_Avoid_: marker, annotation

**Mention**:
An @name in a comment that points a person who can open the page to it: `@sara@acme.com`, or `@team:Design` for the members of a team of the page's workspace who can open it. Mentions send no email.
_Avoid_: tag, ping

**Notification**:
What the bell in Dossier's header lists for a person: a mention of them or of a team they are in, or a reply in a thread they wrote in, on a page they can open now. Reading it, or opening its page, marks it read. Never sent by email.
_Avoid_: alert, inbox item, activity

### Agents

**Agent version**:
What a link returns to an agent: the page's companion if it has one, otherwise Markdown generated from the page, ending, when it is Markdown, with a line that points to its data and comments.
_Avoid_: Markdown version (a companion may be JSON), handoff, prompt

**Companion**:
The file an author writes for agents beside a page: the same-name `.md` by default, or any file the page names with `<link rel="alternate">`, JSON included. It is the page's agent version.
_Avoid_: agent notes, ledger (a ledger is one kind of companion)

**Copy for agent**:
A base-layer component, `<dossier-copy>`, a page or layout can place to copy the page's agent version for pasting into an agent. Dossier never adds it to a page by itself.
_Avoid_: copy prompt, copy handoff

### Dossier's own interface

**Listing**:
Dossier's page for a folder without its own `index.html`. It shows what the folder holds and, to people with the right role, actions such as share, history and restore, and the responses on a page. Listings are Dossier's whole browsing interface.
_Avoid_: dashboard, hub, file browser, explorer

**Shared with me**:
The home that lists everything shared with a person, across workspaces on a deployment.
_Avoid_: inbox, my files

**Seen by**:
The list, visible to write holders, of who opened a page and when they last did.
_Avoid_: views, read receipts, analytics

**Webhook**:
A URL a workspace admin registers to receive signed JSON messages when chosen events happen (submission, comment, mention, share, push). Its events are the same events `watch` reports.
_Avoid_: callback, hook, integration (an integration is what someone builds on a webhook)
