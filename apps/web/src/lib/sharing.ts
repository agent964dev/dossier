// How a tree is shared, as the home writes it; pure, so screens can import it.

/** How a tree is shared with others than the person looking, as listings say. */
export type TreeSharing =
  | { readonly kind: 'private' }
  | { readonly kind: 'workspace' }
  | { readonly kind: 'shared'; readonly people: number; readonly teams: number }
  | { readonly kind: 'public' }

/** How a tree is shared, as its row says it. */
export function treeSharingLabel(sharing: TreeSharing): string {
  switch (sharing.kind) {
    case 'private':
      return 'Private'
    case 'workspace':
      return 'Shared with the workspace'
    case 'public':
      return 'Public'
    case 'shared': {
      const people =
        sharing.people === 1 ? '1 person' : `${sharing.people} people`
      const teams = sharing.teams === 1 ? 'a team' : `${sharing.teams} teams`
      return `Shared with ${[
        ...(sharing.people > 0 ? [people] : []),
        ...(sharing.teams > 0 ? [teams] : []),
      ].join(' and ')}`
    }
  }
}
