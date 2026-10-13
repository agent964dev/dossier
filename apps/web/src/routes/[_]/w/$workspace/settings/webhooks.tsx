import type { EventType } from '@dossier/contracts'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { Check, Copy, Plus, Webhook } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { LocalTime } from '../../../../../components/local-time'
import { MenuButton, RowMenu } from '../../../../../components/row-menu'
import {
  ConfirmDialog,
  Note,
  Refusal,
  ROW,
  RowList,
  refusalOf,
} from '../../../../../components/settings-parts'
import { Button } from '../../../../../components/ui/button'
import { Input, Label } from '../../../../../components/ui/input'
import { Modal } from '../../../../../components/ui/modal'
import { isScreenFailure } from '../../../../../server/failure'
import {
  createWebhook,
  removeWebhook,
  rollWebhookSecret,
  updateWebhook,
  webhooksView,
  type WebhooksView,
} from '../../../../../server/webhooks'
import { Tab, tabRead } from './-tab'

export const Route = createFileRoute('/_/w/$workspace/settings/webhooks')({
  loader: async ({ params, location }) =>
    tabRead(
      await webhooksView({ data: { workspace: params.workspace } }),
      location.href,
    ),
  component: () => (
    <Tab read={Route.useLoaderData()}>
      {(view: WebhooksView) => <Webhooks view={view} />}
    </Tab>
  ),
})

type Row = WebhooksView['webhooks'][number]

/** A URL as the row shows it: without its scheme or a lone trailing slash. */
const shownUrl = (url: string) =>
  url.replace(/^https?:\/\//, '').replace(/\/$/, '')

const EVENT_LABELS: Record<EventType, string> = {
  push: 'push',
  delete: 'delete',
  restore: 'restore',
  move: 'move',
  submission: 'submission',
  entry: 'entry',
  withdrawal: 'withdrawal',
  data_write: 'data write',
  comment: 'comment',
  mention: 'mention',
  share: 'share',
}

function Webhooks({ view }: { view: WebhooksView }) {
  const router = useRouter()
  const [editing, setEditing] = useState<{ row: Row | null } | null>(null)
  const [rolling, setRolling] = useState<Row | null>(null)
  const [deleting, setDeleting] = useState<Row | null>(null)
  const [secret, setSecret] = useState<{ url: string; value: string } | null>(
    null,
  )
  const refresh = () => router.invalidate()

  return (
    <div className="flex flex-col gap-4">
      {view.webhooks.length === 0 ? (
        <p className="text-[0.9375rem] text-neutral-400">No webhooks yet.</p>
      ) : (
        <RowList label="Webhooks">
          {view.webhooks.map((row) => (
            <li key={row.id} className={ROW}>
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-neutral-800/70 text-neutral-300"
              >
                <Webhook className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <span
                  className="block truncate font-mono text-sm text-neutral-50"
                  title={row.url}
                >
                  {shownUrl(row.url)}
                </span>
                <span className="block text-xs text-neutral-400">
                  {row.events.map((e) => EVENT_LABELS[e]).join(', ')}
                </span>
                {row.failing === null ? null : (
                  <span className="mt-0.5 block text-xs text-error-300">
                    Failing since{' '}
                    <LocalTime at={row.failing.since} format="when" /> ·{' '}
                    {row.failing.lastError}
                  </span>
                )}
              </div>
              <RowMenu label={`More for ${shownUrl(row.url)}`}>
                <MenuButton onSelect={() => setEditing({ row })}>
                  Edit
                </MenuButton>
                <MenuButton onSelect={() => setRolling(row)}>
                  Roll secret
                </MenuButton>
                <MenuButton destructive onSelect={() => setDeleting(row)}>
                  Delete
                </MenuButton>
              </RowMenu>
            </li>
          ))}
        </RowList>
      )}
      <Button className="w-fit" onClick={() => setEditing({ row: null })}>
        <Plus aria-hidden />
        Add webhook
      </Button>
      <Note>
        Up to {view.limit} {view.limit === 1 ? 'webhook' : 'webhooks'} per
        workspace. Each gets the events you choose as signed JSON, with retries.
      </Note>
      <WebhookDialog
        key={editing === null ? 'closed' : (editing.row?.id ?? 'new')}
        open={editing !== null}
        view={view}
        row={editing?.row ?? null}
        onClose={() => setEditing(null)}
        onSaved={async (made) => {
          setEditing(null)
          if (made !== null) setSecret(made)
          await refresh()
        }}
      />
      <ConfirmDialog
        open={rolling !== null}
        title="Roll the secret?"
        description={
          rolling === null
            ? undefined
            : `${shownUrl(rolling.url)} gets a new secret at once. Receivers that check the old one refuse every delivery until they have the new one.`
        }
        action="Roll secret"
        onClose={() => setRolling(null)}
        onConfirm={async () => {
          if (rolling === null) return null
          const result = await rollWebhookSecret({
            data: { workspace: view.workspace, id: rolling.id },
          })
          if (isScreenFailure(result)) return result.error.message
          setSecret({ url: rolling.url, value: result.secret })
          return null
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        title="Delete the webhook?"
        description={
          deleting === null
            ? undefined
            : `${shownUrl(deleting.url)} gets nothing more, deliveries waiting included.`
        }
        action="Delete"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting === null) return null
          const message = refusalOf(
            await removeWebhook({
              data: { workspace: view.workspace, id: deleting.id },
            }),
          )
          if (message === null) await refresh()
          return message
        }}
      />
      <SecretOnce secret={secret} onClose={() => setSecret(null)} />
    </div>
  )
}

/** Adds a webhook, or edits one; give it a key per opening. */
function WebhookDialog({
  open,
  view,
  row,
  onClose,
  onSaved,
}: {
  open: boolean
  view: WebhooksView
  /** The webhook to edit; null adds one. */
  row: Row | null
  onClose: () => void
  /** With the new webhook's secret when one was added. */
  onSaved: (made: { url: string; value: string } | null) => Promise<void> | void
}) {
  const [url, setUrl] = useState(row?.url ?? '')
  const [events, setEvents] = useState<readonly EventType[]>(row?.events ?? [])
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<{
    message: string
    path: string | null
  } | null>(null)
  const form = row === null ? 'add-webhook-form' : 'edit-webhook-form'

  const close = () => {
    setRefused(null)
    onClose()
  }

  const toggle = (type: EventType, on: boolean) =>
    setEvents((now) =>
      view.eventTypes.filter((t) => (t === type ? on : now.includes(t))),
    )

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setRefused(null)
    const data = { workspace: view.workspace, url, events: [...events] }
    const result =
      row === null
        ? await createWebhook({ data })
        : await updateWebhook({ data: { ...data, id: row.id } })
    setBusy(false)
    if (isScreenFailure(result)) {
      setRefused({ message: result.error.message, path: result.error.path })
      return
    }
    await onSaved(
      'secret' in result
        ? { url: result.webhook.url, value: result.secret }
        : null,
    )
  }

  const urlRefused = refused?.path === 'url'
  const eventsRefused = refused?.path === 'events'
  return (
    <Modal
      open={open}
      onClose={close}
      title={row === null ? 'Add webhook' : 'Edit webhook'}
      description="Dossier sends each chosen event to this URL as signed JSON."
      footer={
        <>
          <Button variant="ghost" type="button" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form={form} disabled={busy}>
            {row === null ? 'Add' : 'Save'}
          </Button>
        </>
      }
    >
      <form id={form} onSubmit={submit} className="flex flex-col gap-2">
        <Label htmlFor={`${form}-url`}>URL</Label>
        <Input
          id={`${form}-url`}
          type="url"
          inputMode="url"
          value={url}
          maxLength={2048}
          required
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="https://n8n.agent964.com/webhook/dossier"
          className="font-mono"
          aria-invalid={urlRefused ? true : undefined}
          aria-describedby={urlRefused ? `${form}-refused` : undefined}
          onChange={(e) => setUrl(e.target.value)}
        />
        <fieldset
          className="mt-3 flex flex-col gap-2"
          aria-invalid={eventsRefused ? true : undefined}
          aria-describedby={eventsRefused ? `${form}-refused` : undefined}
        >
          <legend className="mb-2 text-sm font-medium text-neutral-300">
            Events
          </legend>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            {view.eventTypes.map((type) => (
              <label
                key={type}
                className="flex items-center gap-2.5 text-[0.9375rem] text-neutral-200"
              >
                <input
                  type="checkbox"
                  checked={events.includes(type)}
                  onChange={(e) => toggle(type, e.target.checked)}
                  className="size-4 accent-brand-300"
                />
                {EVENT_LABELS[type]}
              </label>
            ))}
          </div>
        </fieldset>
        <div id={`${form}-refused`}>
          <Refusal message={refused?.message ?? null} />
        </div>
      </form>
    </Modal>
  )
}

/** A secret, shown once, with a way to copy it. */
function SecretOnce({
  secret,
  onClose,
}: {
  secret: { url: string; value: string } | null
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const close = () => {
    setCopied(false)
    onClose()
  }
  const copy = async () => {
    if (secret === null) return
    await navigator.clipboard.writeText(secret.value)
    setCopied(true)
  }
  return (
    <Modal
      open={secret !== null}
      onClose={close}
      title="Copy the secret now"
      description={secret === null ? undefined : `For ${shownUrl(secret.url)}.`}
      footer={
        <Button type="button" onClick={close}>
          Done
        </Button>
      }
    >
      {secret === null ? null : (
        <div className="flex flex-col gap-3">
          <code className="block rounded-lg border border-border bg-neutral-950 px-3 py-2.5 font-mono text-xs break-all text-brand-100">
            {secret.value}
          </code>
          <Button variant="outline" size="sm" className="w-fit" onClick={copy}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
          </Button>
          <p className="text-sm text-neutral-400">
            Shown once. Receivers check the webhook-signature header with it.
          </p>
        </div>
      )}
    </Modal>
  )
}
