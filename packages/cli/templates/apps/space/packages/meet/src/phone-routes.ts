// The phone's HTTP routes, chosen by path (docs/adr/0004, section 1; the same rule as ADR 0003). The company's people reach the phone through the
// space only, since meet has no teammates' door of its own (/start/api/w/phone) any more:
//
//   /space/phone/*         the company's people   the space's Access application, forwarded over the service binding and checked again in
//                                          space-routes.ts, then the teammate list, then the declaration's `phone.people` in the core (this file's
//                                          `mountPhoneTeammates`). Mints a phone's login, approves each call, keeps the 911
//                                          address and the log. There is NO phone route on the guests' door.
//   /r/api/phone/webhook   Telnyx          no sign-in, but only a request signed by Telnyx (Ed25519 over the timestamp and
//                                          the body, the timestamp within 5 minutes) is read at all.
//   /api/phone/dev/*       a localhost run the development bypass AND the stand-in Telnyx, as the stand-in SFU is: the page's
//                                          stand-in phone reports its calls here, as Telnyx's webhook would. 404 elsewhere.
//
// The core decides (phone.ts); everything external happens here: Telnyx, the email, the digest of a ticket.

import { type Context, Hono } from 'hono'
import type { Deps, MeetPartDeps } from './app'
import { crossSite, isLocal, newToken, sha256Hex } from './door'
import { balanceEmail, capEmail, emergencyEmail, voicemailEmail } from './mail'
import { LINE, lineWords } from './phone-line'
import { isEmergency, type PhoneStatus, displayNumber, parseDestination } from './phone-model'
import type { PhoneAction } from './phone'
import { RoomError } from './room'
import { type PhoneEvent, type Telnyx, TelnyxError, ourState, parseEvent, verifyWebhook } from './telnyx'

/** What the Worker needs to run the phone, or null (no dial pad at all) when it is not all there. */
export interface PhoneRuntime {
  telnyx: Telnyx
  /** The account's webhook public key, base64. Empty for the stand-in. */
  publicKey: string
  /** The line's number, E.164. */
  number: string
  /** meet's own credential connection: events on any other connection are not meet's. */
  connectionId: string
  /** Which phone the page runs: Telnyx's, or the stand-in a localhost run uses. */
  sdk: 'telnyx' | 'fake'
  /** The development webhook routes (`/api/phone/dev/*`), honoured on a localhost run with the bypass alone. */
  dev: boolean
}

/** The refusals that are the caller's to fix are 400 and the rest 403, as the page shows `error` to the person. */
const refusalStatus = (reason: string): 400 | 403 => (reason === 'format' || reason === 'country' ? 400 : 403)

/** The two-letter US state Cloudflare puts a request in, or null (a local run, or outside the US). */
function regionOf(c: Context): string | null {
  const cf = (c.req.raw as unknown as { cf?: { regionCode?: unknown; country?: unknown } }).cf
  return cf?.country === 'US' && typeof cf.regionCode === 'string' && /^[A-Z]{2}$/.test(cf.regionCode) ? cf.regionCode : null
}

const intParam = (v: string | undefined): number => (v !== undefined && /^\d{1,12}$/.test(v) ? Number(v) : Number.NaN)

async function json(c: Context): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json()
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** What was done for a core's decision, for the stand-in's reply and nothing else. */
export interface Performed {
  dials: Array<{ callId: number; leg: string; clientState: string }>
  hangups: string[]
}

/** Do what the core decided. Each step stands alone: a failed email never undoes a dial, and 911 is dialed before it is told. */
export async function perform(d: MeetPartDeps, actions: PhoneAction[]): Promise<Performed> {
  const done: Performed = { dials: [], hangups: [] }
  const rt = d.phone
  if (!rt) return done
  const core = d.phoneCore()
  // A step can lead to more (a leg that could not be made sends the call on to its next stage): they are done after the ones before.
  const queue = [...actions]
  for (let a = queue.shift(); a; a = queue.shift()) {
    try {
      if (a.do === 'dial') {
        const clientState = ourState(a.callId, a.nonce)
        try {
          const { leg } = await rt.telnyx.dial({
            to: a.to,
            from: a.from === 'line' ? rt.number : a.from,
            fromName: lineWords(d.install.company.name).callerName,
            linkTo: a.browserLeg,
            clientState,
            timeLimitSecs: LINE.callLimitSecs,
          })
          const started = await core.dialStarted(a.callId, leg, d.now())
          done.dials.push({ callId: a.callId, leg, clientState })
          // The browser hung up while the dial was out: the leg that just came up has no one to talk to. If Telnyx does not take
          // the hang-up it stays on the core's list and the cron asks again.
          if (started.abandoned) {
            try {
              await rt.telnyx.hangup(leg)
              await core.hangupDone(leg)
              done.hangups.push(leg)
            } catch (err) {
              console.error('hanging up an abandoned leg failed; the cron will try again', err instanceof Error ? err.message : err)
            }
          }
        } catch (err) {
          console.error('phone dial failed', err instanceof Error ? err.message : err)
          await core.dialFailed(a.callId, d.now())
          await rt.telnyx.hangup(a.browserLeg).catch(() => null)
          done.hangups.push(a.browserLeg)
        }
      } else if (a.do === 'hangup') {
        await rt.telnyx.hangup(a.leg)
        done.hangups.push(a.leg)
      } else if (a.do === 'notify911') {
        await d.mailer.send(emergencyEmail(a, d.install, d.install.owner().address))
      } else if (a.do === 'alert') {
        await d.mailer.send(capEmail(a.level, a.used, a.cap, d.install.owner().address, d.install))
      } else if (a.do === 'ring') {
        const state = ourState(a.callId, a.nonce, a.leg)
        const ring = (from: string) =>
          rt.telnyx.ring({ to: a.to, from, fromName: a.fromName, linkTo: a.link, clientState: state, timeoutSecs: a.timeoutSecs, timeLimitSecs: LINE.callLimitSecs })
        try {
          let made: { leg: string }
          try {
            made = await ring(a.from)
          } catch (err) {
            // Showing the caller's own number is a nicety Telnyx may refuse for a number that is not ours: ring from the line's number instead of not at all.
            if (!(err instanceof TelnyxError && (err.status === 400 || err.status === 422)) || a.from === rt.number) throw err
            console.error('ringing with the caller\'s number was refused; ringing from the line\'s own number', err.message)
            made = await ring(rt.number)
          }
          const started = await core.legStarted(a.leg, made.leg, d.now())
          // The call moved on (or the caller hung up) while the request was out: this leg has no one to talk to. The cron asks again if Telnyx does not take it.
          if (started.abandoned) {
            try {
              await rt.telnyx.hangup(made.leg)
              await core.hangupDone(made.leg)
              done.hangups.push(made.leg)
            } catch (err) {
              console.error('hanging up an abandoned leg failed; the cron will try again', err instanceof Error ? err.message : err)
            }
          }
        } catch (err) {
          console.error(`phone ${a.role} leg could not be made`, err instanceof Error ? err.message : err)
          queue.push(...(await core.legFailed(a.leg, d.now())))
        }
      } else if (a.do === 'answer') {
        await rt.telnyx.answer(a.leg, ourState(a.callId, a.nonce, a.legRow))
      } else if (a.do === 'bridge') {
        await rt.telnyx.bridge(a.leg, a.with, ourState(a.callId, a.nonce, a.legRow))
      } else if (a.do === 'screen') {
        await rt.telnyx.screen(a.leg, a.text, ourState(a.callId, a.nonce, a.legRow))
      } else if (a.do === 'speak') {
        await rt.telnyx.speak(a.leg, a.text, ourState(a.callId, a.nonce, a.legRow))
      } else if (a.do === 'record') {
        await rt.telnyx.record(a.leg, a.maxSecs, ourState(a.callId, a.nonce, a.legRow))
      } else {
        await d.mailer.send(voicemailEmail(a.to, a.number, a.seconds, d.install))
      }
    } catch (err) {
      console.error(`phone ${a.do} failed`, err instanceof Error ? err.message : err)
    }
  }
  return done
}

/** A parsed Telnyx event, through the core, and whatever it decided done. */
export async function handleEvent(d: Deps, ev: PhoneEvent): Promise<Performed> {
  // An event on another connection than meet's is not meet's to handle (and never to hang up).
  if (d.phone?.connectionId && ev.connection && ev.connection !== d.phone.connectionId) return { dials: [], hangups: [] }
  const { ticket, ...rest } = ev
  const actions = await d.phoneCore().webhook({ ...rest, ticketHash: ticket ? await sha256Hex(ticket) : null }, d.now(), d.phone?.number ?? '')
  return perform(d, actions)
}

/** The routes for the company's people, mounted by space-routes.ts. `emailOf` is the verified address the space's door has already set. */
export function mountPhoneTeammates(teammates: Hono, deps: (c: Context) => MeetPartDeps, emailOf: (c: Context) => string): void {
  const phone = new Hono()
  phone.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && crossSite(c)) return c.json({ error: 'Cross-site write refused' }, 403)
    await next()
    c.header('cache-control', 'no-store')
  })
  const rt = (c: Context): PhoneRuntime => {
    const r = deps(c).phone
    if (!r) throw new RoomError(404, 'The phone is not set up yet.')
    return r
  }
  const core = (c: Context) => deps(c).phoneCore()

  /** The phone as this person sees it. Nothing here tells a guest or a non-phone teammate that a phone exists. */
  async function status(c: Context): Promise<PhoneStatus | { available: false }> {
    const d = deps(c)
    const email = emailOf(c)
    if (!d.phone || !(await d.phoneCore().eligible(email))) return { available: false }
    const { eligible: _eligible, ...st } = await d.phoneCore().status(email, d.now(), regionOf(c))
    return { ...st, available: true, sdk: d.phone.sdk, line: d.phone.number, lineDisplay: displayNumber(d.phone.number), callerName: lineWords(d.install.company.name).callerName }
  }

  phone.get('/', async (c) => c.json(await status(c)))

  phone.post('/ack', async (c) => {
    rt(c)
    await core(c).ack(emailOf(c), deps(c).now())
    return c.json(await status(c))
  })

  // The 911 address: kept, then put on the number at Telnyx. Calls out wait until Telnyx holds it.
  phone.put('/address', async (c) => {
    const d = deps(c)
    const r = rt(c)
    const email = emailOf(c)
    const saved = await core(c).saveAddress(email, await json(c), d.now())
    try {
      await r.telnyx.registerEmergencyAddress(saved.number === 'line' ? r.number : saved.number, saved.address, saved.name)
      await core(c).addressRegistered(email, saved.at, d.now())
    } catch (err) {
      console.error('911 address not registered', err instanceof Error ? err.message : err)
      const bad = err instanceof TelnyxError && (err.status === 400 || err.status === 422)
      return c.json(
        { error: bad ? 'Telnyx could not verify that address. Check it and try again.' : 'meet kept your address but could not register it for 911. Try again in a minute.' },
        bad ? 400 : 502,
      )
    }
    return c.json(await status(c))
  })

  phone.post('/address/confirm', async (c) => {
    rt(c)
    await core(c).confirmAddress(emailOf(c), regionOf(c))
    return c.json(await status(c))
  })

  // What the line does with a call nobody picks up at once (docs/adr/0005): the cell that rings next, and how long meet rings first.
  phone.put('/settings', async (c) => {
    const r = rt(c)
    await core(c).saveSettings(emailOf(c), await json(c), r.number)
    return c.json(await status(c))
  })

  // A voicemail's sound, for a person of the company only. meet fetches it from Telnyx by its id each time and passes the sound on; the
  // browser is never given a Telnyx address, so there is no link to leak (and the file is not cached anywhere).
  phone.get('/voicemail/:id/audio', async (c) => {
    const r = rt(c)
    const { recordingId } = await core(c).voicemailToPlay(emailOf(c), intParam(c.req.param('id')))
    let res: Response
    try {
      res = await r.telnyx.recordingAudio(recordingId, c.req.header('range') ?? null)
    } catch (err) {
      console.error('voicemail fetch failed', err instanceof Error ? err.message : err)
      throw new RoomError(err instanceof TelnyxError && err.status === 404 ? 404 : 502, err instanceof TelnyxError && err.status === 404 ? 'That recording is no longer at Telnyx.' : 'Could not fetch the recording. Try again.')
    }
    if (res.status === 403 || res.status === 404 || res.status === 410) throw new RoomError(404, 'That recording is no longer at Telnyx.')
    if (res.status !== 200 && res.status !== 206) throw new RoomError(502, 'Could not fetch the recording. Try again.')
    const type = res.headers.get('content-type') ?? ''
    const headers = new Headers({
      'content-type': /^audio\/[a-z0-9.+-]+$/i.test(type) ? type : 'audio/mpeg',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
    })
    for (const name of ['content-length', 'content-range', 'accept-ranges']) {
      const v = res.headers.get(name)
      if (v) headers.set(name, v)
    }
    return new Response(res.body, { status: res.status, headers })
  })

  // Delete a voicemail (its sound at Telnyx first, then its message for everyone) or a missed call's line. If Telnyx will not
  // delete the sound, nothing is deleted here either: a voicemail whose sound is still stored must not look gone.
  phone.delete('/messages/:id', async (c) => {
    const d = deps(c)
    const r = rt(c)
    const email = emailOf(c)
    const id = intParam(c.req.param('id'))
    const { recordingId } = await core(c).voicemailToDelete(email, id)
    if (recordingId) {
      try {
        await r.telnyx.deleteRecording(recordingId)
      } catch (err) {
        console.error('voicemail delete failed', err instanceof Error ? err.message : err)
        throw new RoomError(502, 'Telnyx would not delete the recording. Nothing was deleted; try again in a minute.')
      }
    }
    await core(c).voicemailDeleted(email, id, d.now())
    return c.json({ ok: true })
  })

  // A phone's login. The first request makes this person's credential at Telnyx (kept by id); every request makes a fresh
  // token from it. The API key stays here: only the token goes to the browser.
  phone.post('/token', async (c) => {
    const d = deps(c)
    const r = rt(c)
    const email = emailOf(c)
    let cred = await core(c).credentialOf(email)
    if (!cred) {
      cred = await r.telnyx.createCredential(`meet ${email}`)
      await core(c).saveCredential(email, cred.id, cred.sipUsername)
    }
    return c.json({ token: await r.telnyx.loginToken(cred.id), sdk: r.sdk, who: (await core(c).status(email, d.now(), null)).who })
  })

  // The approval for one call: every rule runs here, with the reason when it says no, and an allowed call that is not 911 gets
  // a ticket the parked call must present. 911 gets none: nothing waits for it.
  phone.post('/call', async (c) => {
    const d = deps(c)
    rt(c)
    const ticket = newToken(d.randomBytes)
    const r = await core(c).issueTicket(emailOf(c), (await json(c)).to, await sha256Hex(ticket), d.now())
    if (!r.ok) return c.json({ error: r.message, reason: r.reason }, refusalStatus(r.reason))
    return c.json({ to: r.dest.e164, display: r.dest.display, emergency: isEmergency(r.dest), ticket: r.ticket ? ticket : null })
  })

  // The page reporting 911, the moment it dials: the owner is emailed. Telnyx's webhook says the same, and the core makes the two one.
  phone.post('/emergency', async (c) => {
    const d = deps(c)
    rt(c)
    const email = emailOf(c)
    const p = parseDestination((await json(c)).to)
    if (!p.ok || p.dest.kind !== 'emergency' || !(await core(c).eligible(email))) throw new RoomError(400, 'bad request')
    const notice = await core(c).notify911(email, '911', d.now())
    if (notice) await perform(d, [{ do: 'notify911', ...notice }])
    return c.json({ ok: true })
  })

  phone.get('/calls', async (c) => {
    rt(c)
    return c.json({ calls: await core(c).recent(emailOf(c)) })
  })

  teammates.route('/phone', phone)
}

/** Telnyx's webhook, and the stand-in's twin of it. Open to no sign-in; the signature is the credential. */
export function mountPhonePublic(app: Hono, deps: (c: Context) => Deps): void {
  app.post(LINE.webhookPath, async (c) => {
    const d = deps(c)
    if (!d.phone) return c.json({ error: 'Not found' }, 404)
    const body = await c.req.text()
    // Telnyx's events are a few KB; anything far past that is not worth a signature check.
    if (body.length > 64_000) return c.json({ error: 'Too large' }, 413)
    const ok = await verifyWebhook({
      publicKey: d.phone.publicKey,
      signature: c.req.header('telnyx-signature-ed25519'),
      timestamp: c.req.header('telnyx-timestamp'),
      body,
      now: d.now(),
    })
    if (!ok) return c.json({ error: 'Unauthorized' }, 401)
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return c.json({ ok: true })
    }
    const ev = parseEvent(parsed)
    if (ev) await handleEvent(d, ev)
    return c.json({ ok: true })
  })

  // The stand-in's door: the page's stand-in phone reports a call as Telnyx's webhook would, unsigned, on localhost only.
  const dev = (c: Context): Deps | null => {
    const d = deps(c)
    return d.devBypass && isLocal(c) && d.phone?.dev ? d : null
  }
  app.post('/api/phone/dev/event', async (c) => {
    const d = dev(c)
    if (!d) return c.json({ error: 'Not found' }, 404)
    if (crossSite(c)) return c.json({ error: 'Cross-site write refused' }, 403)
    const ev = parseEvent(await json(c))
    if (!ev) return c.json({ error: 'bad event' }, 400)
    return c.json(await handleEvent(d, ev))
  })
  app.get('/api/phone/dev/telnyx', (c) => {
    const d = dev(c)
    if (!d) return c.json({ error: 'Not found' }, 404)
    const t = d.phone?.telnyx as { calls?: unknown[] } | undefined
    return c.json({ calls: t?.calls ?? [] })
  })
}

/** The cron's phone chores: tidy up, and once a day look at Telnyx's balance and tell the owner if it is low. Never throws. */
export async function runPhoneChores(d: MeetPartDeps, lowUsd: number = LINE.lowBalanceUsd): Promise<void> {
  const core = d.phoneCore()
  try {
    // A call in that lost an event is wound up: its legs hung up, and a call that came to nothing is a missed call.
    await perform(d, await core.sweep(d.now()))
    // Legs of abandoned calls Telnyx did not take the first hang-up for.
    if (d.phone) {
      for (const leg of await core.pendingHangups(d.now())) {
        try {
          await d.phone.telnyx.hangup(leg)
          await core.hangupDone(leg)
        } catch (err) {
          console.error('hanging up an abandoned leg failed again', err instanceof Error ? err.message : err)
        }
      }
    }
  } catch (err) {
    console.error('phone chores failed', err instanceof Error ? err.message : err)
  }
  try {
    if (!d.phone || !(await core.balanceDue(d.now()))) return
    const { availableUsd } = await d.phone.telnyx.balance()
    // The day's check is done only when the balance was read AND, if it was low, the owner was told: a Telnyx that did not answer or a
    // send that failed is tried again at the next run.
    if (availableUsd < lowUsd) await d.mailer.send(balanceEmail(availableUsd, d.install.owner().address, d.install))
    await core.balanceChecked(d.now())
  } catch (err) {
    console.error('phone balance check failed', err instanceof Error ? err.message : err)
  }
}
