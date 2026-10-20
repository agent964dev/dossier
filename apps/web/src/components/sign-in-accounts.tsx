import { useState } from 'react'

import type { SignInAccountView } from '../core/index'
import { disconnectSignInAccount } from '../server/account'
import { isScreenFailure } from '../server/failure'
import { GoogleMark } from './google-mark'
import { MicrosoftMark } from './microsoft-mark'
import { SectionLabel } from './section-label'
import { ConfirmDialog, Note } from './settings-parts'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

const PROVIDER_NAMES: Record<SignInAccountView['provider'], string> = {
  google: 'Google',
  microsoft: 'Microsoft',
}

const FAILED = "Couldn't disconnect this account. Try again."

/** "its 2 agent keys stop working" */
const keysStop = (count: number) =>
  count === 1
    ? 'its 1 agent key stops working'
    : `its ${count} agent keys stop working`

/**
 * The person's sign-in accounts, each with its provider's mark and the email
 * it last gave. Any account but the last and the one this session uses can
 * be disconnected, after a confirmation.
 */
export function SignInAccounts({
  accounts,
  personEmail,
  onChange,
}: {
  accounts: readonly SignInAccountView[]
  /** The person's email, which a returning account must still own. */
  personEmail: string
  onChange: () => Promise<void>
}) {
  const [disconnecting, setDisconnecting] = useState<SignInAccountView | null>(
    null,
  )
  const only = accounts.length === 1

  const disconnect = async (account: SignInAccountView) => {
    try {
      const result = await disconnectSignInAccount({
        data: { accountId: account.id },
      })
      if (!isScreenFailure(result)) {
        await onChange()
        return null
      }
      if (result.error.code === 'unavailable') return FAILED
      return [result.error.message, result.error.fix]
        .filter((part) => part !== null)
        .join(' ')
    } catch {
      return FAILED
    }
  }

  const provider =
    disconnecting === null ? '' : PROVIDER_NAMES[disconnecting.provider]

  return (
    <section
      aria-labelledby="sign-in-accounts-label"
      className="flex flex-col gap-3"
    >
      <SectionLabel id="sign-in-accounts-label" count={accounts.length}>
        Sign-in accounts
      </SectionLabel>
      <ul className="divide-y divide-border/80 overflow-hidden rounded-xl border border-border bg-card">
        {accounts.map((account) => {
          const name = PROVIDER_NAMES[account.provider]
          return (
            <li
              key={account.id}
              className="flex flex-wrap items-center gap-3 px-3.5 py-3"
            >
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white"
              >
                {account.provider === 'microsoft' ? (
                  <MicrosoftMark className="size-4" />
                ) : (
                  <GoogleMark className="size-4" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[0.9375rem] break-all text-neutral-50">
                  {account.email}
                </p>
                <p className="font-mono text-xs text-neutral-500">{name}</p>
              </div>
              {account.current ? (
                <Badge variant="success">this session</Badge>
              ) : null}
              {only || account.current ? null : (
                <Button
                  variant="outline"
                  size="xs"
                  aria-label={`Disconnect ${name} account ${account.email}`}
                  onClick={() => setDisconnecting(account)}
                >
                  Disconnect
                </Button>
              )}
              {account.current && !only ? (
                <p className="w-full pl-11 text-sm text-neutral-400">
                  To disconnect this account, sign in with another one.
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>
      {only ? (
        <Note>
          This is your only sign-in account. To remove it, delete your account
          below.
        </Note>
      ) : null}
      <ConfirmDialog
        open={disconnecting !== null}
        title={
          disconnecting === null
            ? ''
            : `Disconnect your ${provider} account ${disconnecting.email}?`
        }
        description={
          disconnecting === null
            ? undefined
            : `Its sessions end, ${keysStop(disconnecting.agentKeys)}, and the CLI logins it approved are cancelled. You stay signed in with your other accounts. If you sign in with it again later, it joins you again only when ${provider} can confirm it still owns ${personEmail}.`
        }
        action="Disconnect"
        onConfirm={() =>
          disconnecting === null
            ? Promise.resolve(null)
            : disconnect(disconnecting)
        }
        onClose={() => setDisconnecting(null)}
      />
    </section>
  )
}
