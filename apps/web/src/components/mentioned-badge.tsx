import { Badge } from './ui/badge'

/** "mentioned you": a comment names the viewer on a page they have not opened since. */
export function MentionedBadge({ className }: { className?: string }) {
  return (
    <Badge className={className}>
      <span
        aria-hidden
        className="size-1.5 rounded-full bg-current shadow-[0_0_6px_currentColor]"
      />
      mentioned you
    </Badge>
  )
}
