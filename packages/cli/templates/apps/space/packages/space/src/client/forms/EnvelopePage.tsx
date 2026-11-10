import { useState } from 'react'
import { type EnvelopeView, type RecipientView, api } from './api'
import { useFresh } from '../liveHub'
import { Badge, Button, Card, INPUT, Notice, useLoad, when } from './kit'
import { useOwner } from '../owner'
import { go, href } from './route'
import { SendWarning } from './SendWarning'

const LIVE = ['sent', 'prepared']
const ACTING = ['sent', 'opened', 'consented']

/** Runs an action, shows what went wrong in words, and reloads the envelope. */
function useAct(reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  async function act(run: () => Promise<unknown>, done?: string) {
    setBusy(true)
    setError(null)
    setOk(null)
    try {
      await run()
      if (done) setOk(done)
      await reload()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, ok, act }
}

function EmailPreview({ id }: { id: string }) {
  const { data, error } = useLoad(() => api.preview(id), [id])
  if (error) return <Notice kind="error">{error}</Notice>
  if (!data) return <p className="text-sm text-muted-foreground">Loading the email…</p>
  return (
    <div className="grid gap-2">
      <dl className="grid gap-x-3 gap-y-0.5 text-sm sm:grid-cols-[6rem_1fr]">
        <dt className="text-muted-foreground">From</dt>
        <dd className="break-words">{data.from}</dd>
        <dt className="text-muted-foreground">Reply-To</dt>
        <dd className="break-words">{data.replyTo}</dd>
        <dt className="text-muted-foreground">To</dt>
        <dd className="break-words">{data.to}</dd>
        <dt className="text-muted-foreground">Subject</dt>
        <dd className="break-words font-medium">{data.subject}</dd>
      </dl>
      <iframe title="The email as it will arrive" sandbox="" srcDoc={data.html} className="h-96 w-full rounded-md border border-border bg-white" />
    </div>
  )
}

function Recipients({ view, act }: { view: EnvelopeView; act: ReturnType<typeof useAct> }) {
  const e = view.envelope
  const [fixing, setFixing] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const live = LIVE.includes(e.status)
  return (
    <Card title="Recipients">
      <ul className="divide-y divide-border">
        {view.recipients.map((r: RecipientView) => (
          <li key={r.id} className="grid gap-1 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">
                {r.position}. {r.name}
              </span>
              <span className="text-muted-foreground">
                {r.kind === 'copy' ? 'gets a copy' : r.role}
              </span>
              <Badge status={r.status} />
              <span className="min-w-0 break-all text-muted-foreground">{r.email}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {r.signed_at ? `Signed ${when(r.signed_at)}` : r.declined_at ? `Declined ${when(r.declined_at)}${r.decline_reason ? `: ${r.decline_reason}` : ''}` : r.consent_at ? `Agreed to sign electronically ${when(r.consent_at)}` : r.opened_at ? `Opened ${when(r.opened_at)}` : r.notified_at ? `Emailed ${when(r.notified_at)}` : r.kind === 'copy' ? 'Emailed the finished document at the end' : r.status === 'waiting' && live ? 'Waiting for their turn' : 'Not emailed yet'}
              {r.reminder_count > 0 ? ` · ${r.reminder_count} reminder${r.reminder_count === 1 ? '' : 's'} sent` : ''}
            </p>
            {live ? (
              <div className="flex flex-wrap gap-2">
                {r.kind === 'signer' && ACTING.includes(r.status) ? (
                  <Button kind="quiet" disabled={act.busy} onClick={() => act.act(() => api.remind(e.id, r.id), `Reminded ${r.name}`)}>
                    Remind now
                  </Button>
                ) : null}
                {!r.opened_at && (r.status === 'sent' || r.status === 'waiting') ? (
                  <Button
                    kind="quiet"
                    onClick={() => {
                      setFixing(fixing === r.id ? null : r.id)
                      setEmail(r.email)
                    }}
                  >
                    Correct the address
                  </Button>
                ) : null}
              </div>
            ) : null}
            {fixing === r.id ? (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(ev) => {
                  ev.preventDefault()
                  void act.act(async () => {
                    await api.correct(e.id, r.id, email)
                    setFixing(null)
                  }, `The link to ${r.name} was replaced`)
                }}
              >
                <label className="grid gap-1 text-xs font-medium">
                  New email address
                  <input className={INPUT} type="email" required value={email} onChange={(ev) => setEmail(ev.target.value)} />
                </label>
                <Button type="submit" disabled={act.busy}>
                  Replace the link
                </Button>
                <p className="w-full text-xs text-muted-foreground">The old link stops working at once{r.status === 'sent' ? ' and the new address is emailed' : ''}.</p>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function Timeline({ view }: { view: EnvelopeView }) {
  const owner = useOwner().name
  const instructionById = new Map(view.instructions.map((i) => [i.id, i]))
  return (
    <Card title="Timeline" aside={view.chain.ok ? <span className="text-xs text-pos">The chain of {view.chain.count} events is intact</span> : <span className="text-xs text-destructive">The chain breaks at event {view.chain.brokenAt}</span>}>
      <ol className="divide-y divide-border text-sm">
        {view.events.map((ev) => {
          const ins = typeof ev.details.instruction_id === 'string' ? instructionById.get(ev.details.instruction_id) : undefined
          return (
            <li key={ev.seq} className="grid gap-0.5 py-2 sm:grid-cols-[11rem_1fr] sm:gap-3">
              <span className="text-muted-foreground">{when(ev.at)}</span>
              <span className="min-w-0 break-words">
                <span className="font-medium">{ev.action}</span> by {ev.actor_kind === 'system' ? 'the system' : ev.actor_kind === 'agent' ? `Claude, on ${owner}'s word` : (ev.actor_name ?? ev.actor_email ?? ev.actor_kind)}
                {ev.ip ? <span className="text-muted-foreground"> · {ev.ip}</span> : null}
                {ev.device ? <span className="text-muted-foreground"> · {ev.device}</span> : null}
                {ins ? (
                  <span className="block text-xs text-muted-foreground">
                    {owner}'s words, as Claude recorded them: “{ins.words}”
                  </span>
                ) : null}
              </span>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}

function Certificate({ id }: { id: string }) {
  const { data, error } = useLoad(() => api.certificate(id), [id])
  if (error) return <Notice kind="error">{error}</Notice>
  if (!data) return null
  return (
    <Card title="Certificate of completion">
      <p className="mb-3 text-xs text-muted-foreground">{data.viewNote}</p>
      <dl className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[13rem_1fr]">
        {data.summary.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {data.recipients.map((r) => (
        <div key={r.id} className="mt-3 border-t border-border pt-3">
          <h3 className="text-sm font-semibold">{r.heading}</h3>
          <dl className="mt-1 grid gap-x-3 gap-y-0.5 text-sm sm:grid-cols-[13rem_1fr]">
            {r.rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="break-words">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      <p className="mt-3 break-words text-xs text-muted-foreground">{data.sealParagraph}</p>
    </Card>
  )
}

export function EnvelopePage({ id }: { id: string }) {
  const { data: view, error, reload } = useLoad(() => api.envelope(id), [id])
  const act = useAct(reload)
  const owner = useOwner().name
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState<'send' | 'cancel' | 'purge' | null>(null)
  // The envelope moves on its own (a signer opens or signs it, it is sealed, it expires): it is read again when documents move and when the page is shown again.
  useFresh(['documents'], () => void reload())
  if (error) return <Notice kind="error">{error}</Notice>
  if (!view) return <p className="text-sm text-muted-foreground">Loading…</p>
  const e = view.envelope
  const live = LIVE.includes(e.status)
  const waiting = view.recipients.filter((r) => r.kind === 'signer' && ACTING.includes(r.status))
  return (
    <>
      <div>
        <a href={href('/envelopes')} className="text-sm text-muted-foreground underline">
          Envelopes
        </a>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{e.title}</h1>
          <Badge status={e.status} />
        </div>
        <p className="text-xs text-muted-foreground">
          <a className="underline" href={href(`/clients/${e.client_id}`)}>
            {e.client_name}
          </a>{' '}
          · {e.order_mode === 'sequential' ? 'in order' : 'all at once'} · {e.sent_at ? `sent ${when(e.sent_at)} by ${e.sent_by}` : `drafted ${when(e.created_at)}`}
          {e.expires_at ? ` · expires ${when(e.expires_at)}` : ''}
          {e.sensitive ? ' · holds private information, delivered by link' : ''}
          {e.typed_only ? ' · signed by typing a name only' : ''}
        </p>
        {e.kind === 'form' ? <a className="text-xs underline" href={href(`/envelopes/${e.id}/answers`)}>Answers and uploaded files</a> : null}
      </div>
      {act.error ? <Notice kind="error">{act.error}</Notice> : null}
      {act.ok ? <Notice kind="ok">{act.ok}</Notice> : null}

      {e.status === 'draft' ? (
        <Card title="Ready to send?">
          <p className="mb-3 text-sm">This is the email {view.recipients.find((r) => r.kind === 'signer')?.name} will get. Nothing has gone out. {e.note ? `Your note is in it.` : 'You added no note.'}</p>
          <EmailPreview id={e.id} />
          <div className="mt-3">
            <SendWarning />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {confirming === 'send' ? (
              <>
                <Button disabled={act.busy} onClick={() => act.act(() => api.sendEnvelope(e.id), 'Sent')}>
                  {act.busy ? 'Sending…' : 'Yes, send it now'}
                </Button>
                <Button kind="quiet" onClick={() => setConfirming(null)}>
                  Not yet
                </Button>
                <p className="w-full text-xs text-muted-foreground">
                  This emails {view.recipients.filter((r) => r.kind === 'signer' && (e.order_mode === 'parallel' || r.position === 1)).map((r) => r.email).join(', ')} in {e.client_name}'s name.
                </p>
              </>
            ) : (
              <Button onClick={() => setConfirming('send')}>Send</Button>
            )}
          </div>
        </Card>
      ) : null}

      {live ? (
        <Card title="What is happening">
          <p className="mb-3 text-sm">{waiting.length === 0 ? 'Nobody is waiting to sign.' : `Waiting on ${waiting.map((r) => r.name).join(' and ')}.`}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button kind="quiet" disabled={act.busy || waiting.length === 0} onClick={() => act.act(() => api.remind(e.id), 'Reminder sent')}>
              Remind now
            </Button>
            {confirming === 'cancel' ? null : (
              <Button kind="quiet" onClick={() => setConfirming('cancel')}>
                Cancel this envelope
              </Button>
            )}
          </div>
          {confirming === 'cancel' ? (
            <form
              className="mt-3 grid max-w-xl gap-2"
              onSubmit={(ev) => {
                ev.preventDefault()
                void act.act(() => api.cancel(e.id, reason), 'Cancelled, and everyone who was emailed has been told')
                setConfirming(null)
              }}
            >
              <label className="grid gap-1 text-sm font-medium">
                Why is it being cancelled? Everyone who was emailed will be told.
                <input className={INPUT} required maxLength={500} value={reason} onChange={(ev) => setReason(ev.target.value)} />
              </label>
              <div className="flex gap-2">
                <Button type="submit" disabled={act.busy || reason.trim() === ''}>
                  Cancel the envelope
                </Button>
                <Button kind="quiet" type="button" onClick={() => setConfirming(null)}>
                  Keep it
                </Button>
              </div>
            </form>
          ) : null}
        </Card>
      ) : null}

      {e.status === 'sealing' ? <Notice kind="info">Everyone has signed and the document is being finished. This page updates by itself.</Notice> : null}

      {e.status === 'completed' ? (
        <>
          <Card title="The finished document">
            <p className="mb-3 text-sm">
              Sealed {e.completed_at ? when(e.completed_at) : ''}. {e.sensitive ? 'It holds private information, so every party got a private link, not an attachment.' : 'Every party was emailed a copy.'} Kept until {e.purge_at ? when(e.purge_at) : 'its retention date'}. Downloading it is recorded on the timeline.
            </p>
            <a className="inline-flex min-h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-hi" href={api.finishedUrl(e.id)} download>
              Download the finished PDF
            </a>
          </Card>
          <Certificate id={e.id} />
        </>
      ) : null}

      <Recipients view={view} act={act} />
      <Timeline view={view} />

      {view.instructions.length > 0 ? (
        <Card title="Instructions Claude recorded">
          <p className="mb-2 text-xs text-muted-foreground">This is Claude's own account of what {owner} said in a session with it. This app cannot see that conversation, so it is a record, not proof.</p>
          <ul className="divide-y divide-border text-sm">
            {view.instructions.map((i) => (
              <li key={i.id} className="py-2">
                <span className="font-medium">{i.action}</span> · said {when(i.said_at)} in a session with Claude · recorded {when(i.recorded_at)} · {i.used ? 'used' : 'not used'}
                <span className="block break-words text-muted-foreground">“{i.words}”</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="Mail">
        {view.mail.length === 0 ? <p className="text-sm text-muted-foreground">No mail yet.</p> : null}
        <ul className="divide-y divide-border text-sm">
          {view.mail.map((m) => (
            <li key={m.id} className="grid gap-0.5 py-2 sm:grid-cols-[11rem_1fr] sm:gap-3">
              <span className="text-muted-foreground">{when(m.sent_at ?? m.created_at)}</span>
              <span className="min-w-0 break-words">
                {m.kind} to {m.to_email}: {m.status === 'sent' ? 'sent' : m.status === 'failed' ? `failed (${m.error ?? 'no reason given'})` : `waiting to send${m.error ? ` (last try failed: ${m.error})` : ''}`}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Delete early">
        <p className="mb-2 text-sm">Records are kept until {e.purge_at ? when(e.purge_at) : 'they stop being needed'}. To delete this one now, on the client's instruction, its files, answers and history are removed for good and a tombstone remains.</p>
        {confirming === 'purge' ? (
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={act.busy}
              onClick={async () => {
                await act.act(() => api.purge(e.id))
                go('/envelopes')
              }}
            >
              Delete it for good
            </Button>
            <Button kind="quiet" onClick={() => setConfirming(null)}>
              Keep it
            </Button>
          </div>
        ) : (
          <Button kind="quiet" onClick={() => setConfirming('purge')}>
            Delete this envelope
          </Button>
        )}
      </Card>
    </>
  )
}
