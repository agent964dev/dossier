// The privacy page's text until a super admin replaces it: what Dossier
// keeps about people, said plainly. Keep it in step with what the code
// stores: a new table or cookie that holds something about a person
// belongs here.

/** The longest privacy text a super admin may save. */
export const PRIVACY_TEXT_LIMIT = 20_000

/** Plain text: paragraphs apart by a blank line, list items start "- ". */
export const defaultPrivacyText = (deploymentName: string): string =>
  `Privacy at ${deploymentName}

${deploymentName} runs Dossier. People and their agents publish pages here, share them with others, and collect the answers people send through them. This page says what Dossier keeps about you. The people who run ${deploymentName} can replace this text with their own.

What Dossier keeps

- Your Google sign-in: your Google account's identifier, your name, your email address, the address of your profile picture, and the tokens Google issues when you sign in. Your email is how Dossier knows you: shares, invitations and answers are addressed to it.
- Sessions: each browser you sign in with has a session that ends 30 days after its last use. It records the IP address and the browser it signed in from.
- Agent keys: the keys you create for the Dossier command line, with their names, what they may reach, and when they were last used.
- What you publish: the files you or your agents push, every earlier version of them, and who pushed each version and when.
- What you send: the answers you send through forms on pages, the files you upload with them, and the data pages write for you, with who wrote each and when.
- Comments: the comments you write, and the people you mention in them.
- Seen by: when you open a page, Dossier records that you opened it and when, and shows that to the people who may see who opened the page. A page that anyone may open also counts its views, without names.
- History: each tree keeps a record of its changes (pushes, answers, comments, shares, moves and deletions) and who made them. Admins of a workspace can have these changes sent to addresses they choose.
- Visitors: when you open a public page without signing in, Dossier sets a random cookie so that it can show the page to that browser. The cookie names no one.

Cookies

Dossier sets a session cookie when you sign in, and the visitor cookie above. While you sign in with Google, it also sets a sign-in cookie that protects the sign-in from forgery and lasts at most five minutes. It sets none for advertising or analytics.

No trackers

Dossier's own screens load nothing from other sites: no analytics, no advertising and no tracking. Their fonts are served by ${deploymentName}. Pages that people publish may embed other sites, such as a video, and those sites see that the page was opened.

Who sees what

You see what is shared with you, and the people you share with see what you shared. Admins of a workspace see its members, teams and settings, and can open its trees. Super admins run the deployment: they see each workspace's name and size, never its pages or answers.

How long it is kept

Files and answers that are deleted stay restorable from history for the retention period the super admins set, then they are purged. When you delete your account in your settings, Dossier withdraws your answers, empties your comments, ends your sessions and agent keys, and removes your Google sign-in. Your email stays as the author of what you published and in the history of the trees you changed.

Where it is kept

On Cloudflare, which runs ${deploymentName}. Cloudflare also keeps the deployment's request logs for a short time. Google handles sign-in.

Questions

Ask the people who run ${deploymentName}.
`

/** Line ends made `\n`, outer white space dropped; empty means none. */
export const privacyTextOf = (text: string): string | null => {
  const clean = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim()
  return clean === '' ? null : clean
}
