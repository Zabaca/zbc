// Settings, Notifications: whether THIS browser gets the inbox's notifications, the one button that changes it, and every device the inbox sends to, the
// inbox's installed app and the space's, each with Remove. The inbox's sender serves both until the old one is removed here by hand, so a
// device that is not yet moved over never goes dark, and one that has moved is not told twice.
import { useCallback, useEffect, useState } from 'react'
import type { InboxDevice, InboxNotifications } from '@space/workspace'
import { type AppleDevice, appleFacts, type BrowserFacts, type BrowserState, browserState, failing, notificationsSupported, permission, STEP_NAMES, thisBrowser, turnOff, turnOn, type TurnOnStep, workerProblem } from './notify'
import { useInstall } from './install'
import { Block, Done, Say, Viewed, useAction, when } from './settings-parts'
import { getView, postView, type Loaded, type Said } from './views'

/** What each state of this browser says. `apple` is the device when this is an iPhone or iPad: what to add to the Home Screen, and where its notification settings are. */
export const browserTexts = (host: string, apple: AppleDevice | null = null): Record<BrowserState, string> => ({
  'add-to-home-screen': `Notifications on ${apple === 'iPad' ? 'an iPad' : 'an iPhone'} need the space added to the Home Screen first. In Safari, tap the Share button, choose Add to Home Screen and add it. Then open Space from its new icon (not from Safari), sign in, and come back to this page to turn notifications on. This needs ${apple === 'iPad' ? 'iPadOS' : 'iOS'} 16.4 or later.`,
  unsupported: 'This browser cannot receive notifications. On an iPhone or iPad, update to iOS or iPadOS 16.4 or later and open the space from its Home Screen icon; otherwise use Chrome on your Android phone or your Mac.',
  blocked: `Notifications are blocked for the space on this device. On Android, allow them in the system settings for the Space app (press and hold its icon, App info, Notifications). On the Mac, allow them in Chrome’s site settings for ${host} and for Google Chrome in System Settings, Notifications. On an iPhone or iPad, open the Settings app, then Notifications, then Space, and turn on Allow Notifications. Then open this page again.`,
  'no-key': 'Notifications are not set up on the inbox yet, so they cannot be turned on. Nothing is sent until they are.',
  'stale-key': 'This device was turned on with a key the inbox no longer uses, so no notification reaches it. Turn notifications on again here.',
  off: 'This device does not get notifications from the space.',
  failing: 'This device gets notifications, but the last one did not reach it.',
  on: 'This device gets notifications from the space.',
})

/** What a notification is, said once beside the button that turns them on. */
const WHAT_SHOWS = 'When mail from a person lands in the Inbox, this device shows who wrote and the subject, on the lock screen too, and a tap opens that person’s conversation here. Newsletters, automated senders, your own mail and Claude’s sends make no sound. Your phone, iPad or Mac asks you to allow them first.'

const originText = (d: InboxDevice, mine: boolean): string => (mine ? 'This device' : d.origin === 'space' ? 'The space' : 'The inbox app (old)')

/** The devices in the order a person wants them: this one, then the space’s, then the inbox’s that are still to be moved. */
export function ordered(devices: readonly InboxDevice[], mineId: string | null): InboxDevice[] {
  const rank = (d: InboxDevice) => (d.id === mineId ? 0 : d.origin === 'space' ? 1 : 2)
  return [...devices].sort((a, b) => rank(a) - rank(b) || a.addedAt - b.addedAt)
}

/** The steps to move from the inbox's installed app to the space's, said while any inbox device is still listed. */
export function Moving({ oldOnes, mineIsSpace }: { oldOnes: number; mineIsSpace: boolean }) {
  if (oldOnes === 0) return null
  return (
    <div className="s-note" data-testid="moving">
      <p>
        <b>Moving over from the inbox app.</b> {oldOnes === 1 ? 'One device is' : `${oldOnes} devices are`} still turned on from the inbox app. Until you remove {oldOnes === 1 ? 'it' : 'them'},
        each new email notifies both the old app and the space, so it arrives twice.
      </p>
      <ol>
        <li>On each phone and computer, add the space to the home screen (or install it from Chrome’s address bar) and open it from there.</li>
        <li>{mineIsSpace ? 'Notifications are on for this device. Do the same on your other devices.' : 'Come here and turn notifications on.'}</li>
        <li>Then remove that device’s old inbox entry below.</li>
      </ol>
    </div>
  )
}

export function NotificationsPanel({
  state,
  device,
  notifications,
  busy,
  step = null,
  worker = null,
  apple = null,
  removing = null,
  onTurnOn,
  onTurnOff,
  onTest,
  onAskRemove,
  onRemove,
  onCancelRemove,
}: {
  state: BrowserState
  /** This browser's device, when the inbox lists one. */
  device: InboxDevice | null
  notifications: InboxNotifications
  busy: boolean
  step?: TurnOnStep | null
  worker?: string | null
  /** The Apple device this is, for the words of the states that name where to tap. */
  apple?: AppleDevice | null
  /** The device a Remove was pressed on and not yet confirmed. */
  removing?: string | null
  onTurnOn(): void
  onTurnOff(): void
  onTest(id: string): void
  onAskRemove(id: string): void
  onRemove(id: string): void
  onCancelRemove(): void
}) {
  const { host } = useInstall()
  const workerSays = worker !== null && state !== 'add-to-home-screen' && state !== 'unsupported' && state !== 'no-key'
  const amber = state === 'failing' || state === 'stale-key' || state === 'blocked' || workerSays
  // Turning on again helps only when the push service refused this device (a key it no longer matches).
  const turnOnAgain = state === 'failing' && device?.refused === true
  const devices = ordered(notifications.devices, device?.id ?? null)
  const oldOnes = notifications.devices.filter((d) => d.origin === 'inbox').length
  return (
    <>
      <div className={`s-card${amber ? ' amber' : ''}`} data-testid="browser">
        <p className="s-lead" role="status" data-state={state}>
          {browserTexts(host, apple)[state]}
        </p>
        {state === 'failing' && device?.lastFailure && <p>{device.lastFailure}</p>}
        {workerSays && <p>{worker}</p>}
        {busy && step && (
          <p className="sub" role="status">
            Turning on: {STEP_NAMES[step]}...
          </p>
        )}
        {(state === 'off' || state === 'stale-key' || turnOnAgain) && <p className="sub">{WHAT_SHOWS}</p>}
        {state !== 'add-to-home-screen' && state !== 'unsupported' && state !== 'blocked' && state !== 'no-key' && (
          <div className="s-actions">
            {(state === 'off' || state === 'stale-key' || turnOnAgain) && (
              <button type="button" className="btn primary" disabled={busy} onClick={onTurnOn} data-testid="turn-on">
                {state === 'off' ? 'Turn on notifications' : 'Turn notifications on again'}
              </button>
            )}
            {(state === 'on' || state === 'failing') && (
              <button type="button" className="btn" disabled={busy} onClick={onTurnOff} data-testid="turn-off">
                Turn off on this device
              </button>
            )}
          </div>
        )}
      </div>

      <Moving oldOnes={oldOnes} mineIsSpace={device?.origin === 'space'} />

      {state !== 'no-key' && devices.length > 0 && (
        <ul className="s-list" aria-label="Devices" data-testid="devices">
          {devices.map((d) => {
            const mine = device?.id === d.id
            const stopped = failing(d)
            return (
              <li key={d.id} className="s-item" data-testid="device" data-origin={d.origin} data-mine={mine}>
                <div className="s-item-main">
                  <p className="s-item-title">
                    {d.label} <span className={`kindtag${d.origin === 'inbox' ? ' old' : ''}`}>{originText(d, mine)}</span>
                  </p>
                  <p className="sub">
                    On since {when(d.addedAt)}. {d.lastDeliveredAt ? `Last notification ${when(d.lastDeliveredAt)}.` : 'No notification yet.'} {d.delivered} delivered, {d.failed} failed.
                  </p>
                  {stopped && d.lastFailure && <p className="s-warn">{when(d.lastFailedAt)}: {d.lastFailure}</p>}
                  {removing === d.id && (
                    <div className="s-ask danger" role="group" aria-label={`Remove ${d.label}?`} data-testid="ask">
                      <p className="s-ask-q">
                        Remove this {d.origin === 'inbox' ? 'inbox app ' : ''}device? It gets no more notifications. {d.origin === 'inbox' ? 'Do this once the space is turned on for that phone or computer.' : 'You can turn them on again from it.'}
                      </p>
                      <div className="s-actions">
                        <button type="button" className="btn danger" disabled={busy} onClick={() => onRemove(d.id)} data-testid="ask-yes">
                          Yes, remove it
                        </button>
                        <button type="button" className="btn" disabled={busy} onClick={onCancelRemove} data-testid="ask-no">
                          Keep it
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                {removing !== d.id && (
                  <div className="s-actions">
                    {mine && (
                      <button type="button" className="btn" disabled={busy} onClick={() => onTest(d.id)} data-testid="test-device">
                        Send a test
                      </button>
                    )}
                    <button type="button" className="btn danger" disabled={busy} onClick={() => onAskRemove(d.id)} data-testid="remove-device">
                      Remove
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {state !== 'no-key' && (
        <p className="sub" data-testid="week">
          In the last 7 days: {notifications.week.sent} notification{notifications.week.sent === 1 ? '' : 's'} sent, {notifications.week.dropped} dropped (found after the hour, or with no device to go to).
        </p>
      )}
    </>
  )
}

/** The section with its data: the inbox's answer and this browser as a device, read again after every change. */
export function NotificationsSection() {
  const [view, setView] = useState<Loaded<InboxNotifications>>({ kind: 'loading' })
  const [here, setHere] = useState<BrowserFacts['thisBrowser']>(null)
  const [worker, setWorker] = useState<string | null>(null)
  const [step, setStep] = useState<TurnOnStep | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [problem, setProblem] = useState<Said | null>(null)
  const action = useAction()

  const load = useCallback(async () => {
    const [got, sub, why] = await Promise.all([getView<InboxNotifications>('notifications'), thisBrowser().catch(() => null), workerProblem()])
    setView((held) => (got.kind === 'said' && held.kind === 'value' ? held : got))
    setProblem(got.kind === 'said' ? got.say : null)
    setHere(sub)
    setWorker(why)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** Something the browser does, with its words if it fails (the browser's steps throw; the inbox's refusals are `Error`s with their words). */
  async function browser(what: () => Promise<void>, done: string) {
    action.clear()
    setProblem(null)
    const result = await action.run(
      async () => {
        try {
          await what()
          return { ok: true as const, value: null }
        } catch (e) {
          return { ok: false as const, say: { tone: 'bad' as const, text: e instanceof Error ? e.message : String(e), again: false } }
        }
      },
      done,
    )
    setStep(null)
    if (result) setRemoving(null)
    await load()
  }

  return (
    <Block title="Notifications" testid="notifications">
      <Viewed view={view} problem={problem} reload={() => void load()} loading="Loading notifications">
        {(n) => {
          const apple = appleFacts()
          const { state, device } = browserState({ supported: notificationsSupported(), permission: permission(), notifications: n, thisBrowser: here, apple })
          return (
            <NotificationsPanel
              state={state}
              device={device}
              notifications={n}
              busy={action.busy}
              step={step}
              worker={worker}
              apple={apple?.device ?? null}
              removing={removing}
              onTurnOn={() => n.publicKey && void browser(() => turnOn(n.publicKey as string, setStep), 'Notifications are on for this device.')}
              onTurnOff={() => void browser(() => turnOff(device?.id ?? null), 'Notifications are off on this device.')}
              onTest={(id) =>
                void browser(async () => {
                  const sent = await postView<{ outcome: string }>('device-test', { id })
                  if (!sent.ok) throw new Error(sent.say.text)
                  if (sent.value.outcome !== 'delivered') throw new Error('The push service did not take the test notification.')
                }, 'Test notification sent. It should show in a few seconds.')
              }
              onAskRemove={setRemoving}
              onCancelRemove={() => setRemoving(null)}
              onRemove={(id) =>
                void browser(async () => {
                  if (id === device?.id) return turnOff(id)
                  const removed = await postView('device-remove', { id })
                  if (!removed.ok) throw new Error(removed.say.text)
                }, 'Removed. That device gets no more notifications.')
              }
            />
          )
        }}
      </Viewed>
      {action.say && <Say say={action.say} />}
      <Done text={action.done} />
    </Block>
  )
}
