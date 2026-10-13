import { Server } from 'lucide-react'

import { SectionLabel } from './section-label'
import { Button } from './ui/button'

/**
 * The account page's way to the deployment's settings, for super admins
 * only; everyone else sees nothing.
 */
export function DeploymentSettings({ superAdmin }: { superAdmin: boolean }) {
  if (!superAdmin) return null
  return (
    <section aria-labelledby="deployment-label" className="flex flex-col gap-3">
      <SectionLabel id="deployment-label">Deployment</SectionLabel>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <a href="/_/admin">Deployment settings</a>
        </Button>
      </div>
      <p className="flex gap-2 text-sm text-neutral-400">
        <Server
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-neutral-500"
        />
        You are a super admin: who may create workspaces, limits, the Look and
        the deployment&apos;s health.
      </p>
    </section>
  )
}
