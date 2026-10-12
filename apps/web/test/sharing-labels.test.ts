import type { Person } from '@dossier/contracts'
import { afterEach, describe, expect, it } from 'vitest'

import { treeSharingLabel, type CommitResult } from '../src/core/index.ts'
import { homeModel } from '../src/server/home-model.ts'
import { listingModel } from '../src/server/listing-model.ts'
import { harness } from './support/harness.ts'
import { runAs, sessionFor } from './support/people.ts'
import {
  agent,
  join,
  nodeAt,
  person,
  pushAll,
  share,
  team,
  workspace,
} from './support/trees.ts'

afterEach(() => harness.reset())

describe('how a tree is shared', () => {
  it('reads alike on the home and on its listing, teams included', async () => {
    const admin = await person('admin')
    const ws = await workspace(admin)
    const member = await person('member')
    await join(ws, member)
    const design = await team(ws, 'Design', [member])
    const pushed = (await pushAll(await agent(admin), `${ws.name}/kit`, {
      'index.html': '<title>Kit</title>',
    })) as CommitResult
    const root = (await nodeAt(pushed.treeId, ''))!.id
    await share(pushed.treeId, root, 'team', design.id, 'read', admin)

    const seenBy = async (who: Person) => {
      const browser = await sessionFor(who)
      const home = await runAs(browser, homeModel({ w: ws.name }))
      const tree = home.trees.find((t) => t.name === 'kit')!
      const listing = await runAs(
        browser,
        listingModel({ workspace: ws.name, tree: 'kit', path: '' }),
      )
      return {
        home: treeSharingLabel(tree.sharing),
        listing: (listing as { sharing: string }).sharing,
      }
    }
    // The admin made it: others are the team.
    expect(await seenBy(admin)).toEqual({
      home: 'Shared with a team',
      listing: 'Shared with a team',
    })
    // A member of the team: others are the admin and the team.
    expect(await seenBy(member)).toEqual({
      home: 'Shared with 1 person and a team',
      listing: `Shared with ${admin.email.toLowerCase()} and 1 other`,
    })
  })
})
