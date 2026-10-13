// Workspace admins manage webhooks: who may, the limit, where a webhook may
// send, and the secret shown only when it is made.
import type { Person } from '@dossier/contracts'
import { env } from 'cloudflare:workers'
import { Effect } from 'effect'
import { Webhook } from 'standardwebhooks'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  DEFAULT_LIMITS,
  People,
  type Caller,
  type WebhookId,
} from '../src/core/index.ts'
import { webhookUrl } from '../src/core/webhook-url.ts'
import { newWebhookSecret, signWebhook } from '../src/core/webhook-signing.ts'
import { webhooksModel } from '../src/server/webhooks-model.ts'
import { beforeBatch, exec } from './support/d1.ts'
import { testRuntime, withRuntime } from './support/harness.ts'
import { runAs, sessionFor } from './support/people.ts'
import {
  agent,
  failureAs,
  join,
  person,
  superAdmin,
  workspace,
} from './support/trees.ts'
import { webhooks } from './support/webhooks.ts'

const HOOK = 'https://n8n.agent964.com/webhook/dossier'

let admin: Person
let adminCaller: Caller
let ws: { id: string; name: string }

beforeAll(async () => {
  admin = await person('admin')
  adminCaller = await sessionFor(admin)
  ws = await workspace(admin)
})

const add = (caller: Caller, url = HOOK, events = ['push'] as const) =>
  runAs(
    caller,
    webhooks((w) => w.create({ workspace: ws.name, url, events: [...events] })),
  )

describe('who manages webhooks', () => {
  it('lets an admin list, add, edit, roll and delete, and refuses a member and a stranger', async () => {
    const member = await person('member')
    await join(ws, member)
    const memberCaller = await sessionFor(member)
    const stranger = await sessionFor(await person('stranger'))
    const made = await add(adminCaller)
    const id = made.webhook.id

    const refusals = async (caller: Caller) =>
      Promise.all([
        failureAs(
          caller,
          webhooks((w) => w.list(ws.name)),
        ),
        failureAs(
          caller,
          webhooks((w) =>
            w.create({ workspace: ws.name, url: HOOK, events: ['push'] }),
          ),
        ),
        failureAs(
          caller,
          webhooks((w) =>
            w.update({
              workspace: ws.name,
              id,
              url: HOOK,
              events: ['comment'],
            }),
          ),
        ),
        failureAs(
          caller,
          webhooks((w) => w.rollSecret({ workspace: ws.name, id })),
        ),
        failureAs(
          caller,
          webhooks((w) => w.remove({ workspace: ws.name, id })),
        ),
      ])
    for (const refused of await refusals(memberCaller)) {
      expect(refused).toMatchObject({ code: 'forbidden' })
    }
    for (const refused of await refusals(stranger)) {
      expect(refused).toMatchObject({ code: 'not_found' })
    }
    // A missing workspace answers as one the caller is not in.
    expect(
      await failureAs(
        adminCaller,
        webhooks((w) => w.list('nosuchspace')),
      ),
    ).toMatchObject({ code: 'not_found' })
    // An admin's agent key does not manage webhooks: they are a screen's.
    expect(
      await failureAs(
        await agent(admin),
        webhooks((w) => w.list(ws.name)),
      ),
    ).toMatchObject({ code: 'not_found' })

    const listed = await runAs(
      adminCaller,
      webhooks((w) => w.list(ws.name)),
    )
    expect(listed.webhooks.map((h) => h.id)).toContain(id)
    const edited = await runAs(
      adminCaller,
      webhooks((w) =>
        w.update({
          workspace: ws.name,
          id,
          url: `${HOOK}/v2`,
          events: ['mention', 'submission', 'mention'],
        }),
      ),
    )
    expect(edited).toMatchObject({
      url: `${HOOK}/v2`,
      events: ['submission', 'mention'],
      failing: null,
    })
    const rolled = await runAs(
      adminCaller,
      webhooks((w) => w.rollSecret({ workspace: ws.name, id })),
    )
    expect(rolled.secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/)
    expect(rolled.secret).not.toBe(made.secret)
    await runAs(
      adminCaller,
      webhooks((w) => w.remove({ workspace: ws.name, id })),
    )
    const after = await runAs(
      adminCaller,
      webhooks((w) => w.list(ws.name)),
    )
    expect(after.webhooks.map((h) => h.id)).not.toContain(id)
    expect(
      await failureAs(
        adminCaller,
        webhooks((w) => w.rollSecret({ workspace: ws.name, id })),
      ),
    ).toMatchObject({ code: 'not_found' })
  })

  it('writes nothing when the admin is demoted between the check and the batch', async () => {
    const other = await person('other-admin')
    await join(ws, other, 'admin')
    const otherCaller = await sessionFor(other)
    const before = await runAs(
      adminCaller,
      webhooks((w) => w.list(ws.name)),
    )
    const DB = beforeBatch(
      env.DB,
      (query) => query.includes('insert into webhooks'),
      async () => {
        await exec(
          "update workspace_members set role = 'member' where workspace_id = ? and user_id = ?",
          ws.id,
          other.id,
        )
      },
    )
    const refused = await withRuntime(testRuntime({ env: { DB } }), () =>
      failureAs(
        otherCaller,
        webhooks((w) =>
          w.create({ workspace: ws.name, url: HOOK, events: ['push'] }),
        ),
      ),
    )
    expect(refused).toMatchObject({ code: 'not_found' })
    const after = await runAs(
      adminCaller,
      webhooks((w) => w.list(ws.name)),
    )
    expect(after.webhooks).toHaveLength(before.webhooks.length)
  })

  it('refuses a suspended workspace’s admin a change', async () => {
    const owner = await person('suspended-admin')
    const caller = await sessionFor(owner)
    const space = await workspace(owner)
    await exec(
      'update workspaces set suspended_at = ? where id = ?',
      Date.now(),
      space.id,
    )
    expect(
      await failureAs(
        caller,
        webhooks((w) =>
          w.create({ workspace: space.name, url: HOOK, events: ['push'] }),
        ),
      ),
    ).toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('is suspended'),
    })
  })
})

describe('the webhook limit', () => {
  it('refuses the eleventh webhook with the limit, and a raised limit lets it through', async () => {
    const owner = await person('limit-admin')
    const caller = await sessionFor(owner)
    const space = await workspace(owner)
    const chief = await person('chief')
    await superAdmin(chief)
    const chiefCaller = await sessionFor(chief)
    const create = () =>
      webhooks((w) =>
        w.create({ workspace: space.name, url: HOOK, events: ['push'] }),
      )
    for (let n = 0; n < DEFAULT_LIMITS.webhooksPerWorkspace; n += 1) {
      await runAs(caller, create())
    }
    expect(await failureAs(caller, create())).toMatchObject({
      code: 'too_large',
      message:
        'This workspace has 10 webhooks, its limit. A super admin can raise it.',
    })
    await runAs(
      chiefCaller,
      Effect.flatMap(People, (p) => p.setLimits({ webhooksPerWorkspace: 11 })),
    )
    try {
      await runAs(caller, create())
      expect(await failureAs(caller, create())).toMatchObject({
        code: 'too_large',
        message: expect.stringContaining('11 webhooks'),
      })
      const listed = await runAs(
        caller,
        webhooks((w) => w.list(space.name)),
      )
      expect(listed).toMatchObject({ limit: 11 })
      expect(listed.webhooks).toHaveLength(11)
    } finally {
      await runAs(
        chiefCaller,
        Effect.flatMap(People, (p) => p.setLimits('defaults')),
      )
    }
  })
})

describe('where a webhook sends', () => {
  it('refuses http, credentials, the main host, a content host and an empty choice of events', async () => {
    const refused = async (url: string, events: string[] = ['push']) =>
      failureAs(
        adminCaller,
        webhooks((w) =>
          w.create({ workspace: ws.name, url, events: events as never }),
        ),
      )
    for (const url of [
      'http://n8n.agent964.com/hook',
      'https://user:pass@n8n.agent964.com/hook',
      'https://user@n8n.agent964.com/hook',
      'https://dossier.test/hook',
      'https://dossier.test:8443/hook',
      'https://abcdefghij0123456789.content.test/hook',
      'https://content.test/hook',
      'not a url',
      `https://n8n.agent964.com/${'a'.repeat(2048)}`,
    ]) {
      expect(await refused(url), url).toMatchObject({
        code: 'invalid',
        message: 'Use an https URL on another host.',
        path: 'url',
      })
    }
    expect(await refused(HOOK, [])).toMatchObject({
      code: 'invalid',
      message: 'Choose at least one event.',
    })
    expect(await refused(HOOK, ['push', 'nonsense'])).toMatchObject({
      code: 'invalid',
      path: 'events',
    })
  })

  it('refuses a URL that names a loopback, private, link-local or metadata address', () => {
    const rules = {
      origin: new URL('https://dossier.agent964.com'),
      contentHost: '{tree}.dossier-content.com',
    }
    for (const url of [
      'https://localhost/hook',
      'https://app.localhost/hook',
      'https://127.0.0.1/hook',
      'https://2130706433/hook',
      'https://0x7f.0.0.1/hook',
      'https://10.0.0.8/hook',
      'https://172.16.4.1/hook',
      'https://192.168.1.10/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://100.64.0.1/hook',
      'https://0.0.0.0/hook',
      'https://[::1]/hook',
      'https://[::]/hook',
      'https://[fe80::1]/hook',
      'https://[fd00::1]/hook',
      'https://[::ffff:127.0.0.1]/hook',
      'https://[::ffff:a9fe:a9fe]/hook',
      'https://[64:ff9b::7f00:1]/hook',
      'https://[2002:7f00:1::]/hook',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://router.local/hook',
      'https://printer.lan/hook',
      'https://intranet/hook',
      'https://example.dossier-content.com/hook',
      'https://abc-dev.dossier-content.com/hook',
      'https://dossier.agent964.com./hook',
    ]) {
      expect(webhookUrl(url, rules), url).toBeNull()
    }
    for (const url of [
      'https://n8n.agent964.com/webhook/dossier',
      'https://hooks.example.com:8443/in?token=abc',
      'https://93.184.216.34/hook',
      'https://[2606:4700:4700::1111]/hook',
      'https://xn--mnchen-3ya.de/hook',
    ]) {
      expect(webhookUrl(url, rules), url).not.toBeNull()
    }
  })

  it('lets a deployment on this machine send to this machine, for local checks', () => {
    const rules = {
      origin: new URL('https://localhost:9087'),
      contentHost: '{tree}.content.localhost:9087',
    }
    expect(webhookUrl('http://localhost:9199/hook', rules)).toBe(
      'http://localhost:9199/hook',
    )
    expect(webhookUrl('https://127.0.0.1:9199/hook', rules)).not.toBeNull()
    expect(webhookUrl('https://localhost:9087/_/api/health', rules)).toBeNull()
    expect(webhookUrl('https://abc.content.localhost:9087/x', rules)).toBeNull()
    expect(webhookUrl('https://10.0.0.8/hook', rules)).toBeNull()
  })
})

describe('the secret', () => {
  it('comes back only from adding and rolling, never from a list, an edit or the tab', async () => {
    const made = await add(adminCaller, `${HOOK}/secret`)
    expect(made.secret).toMatch(/^whsec_/)
    expect(JSON.stringify(made.webhook)).not.toContain('whsec_')
    const id = made.webhook.id as WebhookId
    const listed = await runAs(
      adminCaller,
      webhooks((w) => w.list(ws.name)),
    )
    expect(JSON.stringify(listed)).not.toContain('whsec_')
    const edited = await runAs(
      adminCaller,
      webhooks((w) =>
        w.update({ workspace: ws.name, id, url: HOOK, events: ['share'] }),
      ),
    )
    expect(JSON.stringify(edited)).not.toContain('whsec_')
    const tab = await runAs(adminCaller, webhooksModel(ws.name))
    expect(JSON.stringify(tab)).not.toContain('whsec_')
    expect(tab.eventTypes).toHaveLength(11)
  })

  it('signs as Standard Webhooks does', async () => {
    const secret = newWebhookSecret()
    const body = '{"type":"push"}'
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = await Effect.runPromise(
      signWebhook({ secret, id: 'evt_x_1', timestamp, body }),
    )
    expect(signature).toMatch(/^v1,/)
    expect(
      new Webhook(secret).verify(body, {
        'webhook-id': 'evt_x_1',
        'webhook-timestamp': String(timestamp),
        'webhook-signature': signature,
      }),
    ).toEqual({ type: 'push' })
    expect(() =>
      new Webhook(newWebhookSecret()).verify(body, {
        'webhook-id': 'evt_x_1',
        'webhook-timestamp': String(timestamp),
        'webhook-signature': signature,
      }),
    ).toThrow()
  })
})
