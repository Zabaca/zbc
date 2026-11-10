// Seam 3b: the sound check. Real Chrome with its fake microphone and the real page,
// but no SFU and no secrets: the call API is answered by this script, so it runs in
// a worktree and in CI as well as on the machine that holds the keys.
//
//   bun run dev                       (packages/meet; nothing else needed)
//   bun scripts/audio.ts [--base http://localhost:4812] [--shots <dir>] [--chrome <path>]
//
// It checks what the sound features do on this side of the wire:
//   1. the level bar moves with Chrome's fake microphone, in the lobby and on your own tile,
//      with noise cancellation on (the processed sound) and off (the raw microphone),
//   2. the Self-check: an audio worklet that loads and then outputs silence, a worklet that
//      cannot load, and an audio context that never starts each end with the raw microphone
//      track on the sender, the notice shown, and the other legs of the call untouched,
//   3. the microphone picker, in the lobby and in the call, changes the microphone without
//      changing the published track,
//   4. a remote person's level lights their tile (a real WebRTC loopback stands in for the
//      SFU), and a person publishing sound that never arrives is flagged on their tile,
//   5. a microphone the SFU refuses is said out loud, and ?debug=1 shows the diagnostics.
//
// What it cannot check is the SFU itself: that audio packets reach the other tab after a
// fallback is in scripts/live.ts.

import { mkdirSync } from 'node:fs'
import type { Browser, Page } from 'playwright'
import {
  AUTOPLAY_BLOCKED,
  BASE,
  NO_WORKLET,
  RESUME_GATE,
  SHOTS,
  SILENT_WORKLET,
  SUSPENDED_CONTEXT,
  WAITS_FOR_TAP,
  check,
  finish,
  launch,
  level,
  micSender,
  peakLevel,
  shoot,
  sleep,
  speechLikeWav,
  waitFor,
} from './harness'

const ROOM = 'k7m2qx9frtn4w6hbc8jd'
const CALL_URL = `${BASE}/r/${ROOM}`

/** What the stubbed SFU says is in the call. */
interface World {
  /** Someone else, publishing a microphone. */
  ben: boolean
  /** The SFU refuses the microphone. */
  refuseMic: boolean
}

type Fault = 'silent-worklet' | 'no-worklet' | 'suspended-context' | 'autoplay-blocked' | 'waits-for-tap' | 'resume-gate'

async function stubApi(page: Page, world: World): Promise<void> {
  const snapshot = (name: string) => ({
    revision: 1,
    count: world.ben ? 2 : 1,
    cap: 8,
    quality: 'full',
    members: [
      { id: 'me', name, muted: false, cameraOff: false, publishing: [{ kind: 'mic', v: 1 }, { kind: 'camera', v: 1 }] },
      ...(world.ben ? [{ id: 'ben', name: 'Ben', muted: false, cameraOff: true, publishing: [{ kind: 'mic', v: 1 }] }] : []),
    ],
  })
  let myName = 'Ana'
  await page.route(`**/r/api/rooms/${ROOM}**`, async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname.replace(`/r/api/rooms/${ROOM}`, '') || '/'
    const json = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    switch (path) {
      case '/':
        return json({ count: world.ben ? 1 : 0, cap: 8, full: false, paused: false, pausedUntil: null })
      case '/join':
        myName = (req.postDataJSON() as { name?: string }).name || 'Guest'
        return json({ memberId: 'me', generation: 1, snapshot: snapshot(myName), chatLast: 0, iceServers: [] })
      case '/checkin':
        return json({ snapshot: snapshot(myName), chat: { messages: [], last: 0 } })
      case '/publish':
        return json({
          answer: null,
          published: world.refuseMic ? ['camera'] : ['mic', 'camera'],
          failed: world.refuseMic ? [{ kind: 'mic', error: 'refused' }] : [],
        })
      case '/subscribe':
        return json({ offer: null, requiresImmediateRenegotiation: false, tracks: [], failed: [] })
      default:
        return json({ ok: true, answer: null })
    }
  })
}

async function openPage(
  browser: Browser,
  opts: { world?: Partial<World>; fault?: Fault; query?: string; viewport?: { width: number; height: number } } = {},
): Promise<Page> {
  const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`))
  if (opts.fault === 'silent-worklet') await page.addInitScript(SILENT_WORKLET)
  if (opts.fault === 'suspended-context') await page.addInitScript(SUSPENDED_CONTEXT)
  if (opts.fault === 'no-worklet') await page.addInitScript(NO_WORKLET)
  if (opts.fault === 'autoplay-blocked') await page.addInitScript(AUTOPLAY_BLOCKED)
  if (opts.fault === 'waits-for-tap') await page.addInitScript(WAITS_FOR_TAP)
  if (opts.fault === 'resume-gate') await page.addInitScript(RESUME_GATE)
  await stubApi(page, { ben: false, refuseMic: false, ...opts.world })
  await page.goto(`${CALL_URL}${opts.query ?? ''}`)
  return page
}

/** Name typed with real key presses (a tap, to a browser), then wait for the lobby to be ready to join. */
async function ready(page: Page, name = 'Ana'): Promise<void> {
  await page.getByPlaceholder('Guest').pressSequentially(name)
  await waitFor('the Join button', async () => page.getByRole('button', { name: 'Join' }).isEnabled())
  // The lobby is up; a tap on the page is what lets a browser start the audio context.
  await page.mouse.click(4, 4)
}

async function join(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Join' }).click()
  await page.getByTestId('count').waitFor({ timeout: 20_000 })
}

const audioState = (page: Page) => page.evaluate(() => (window as any).__meetAudio.getState())

/**
 * A real peer connection pair in the page stands in for the SFU: a tone goes through it and comes out as a
 * remote stream, handed to the controller as Ben's received microphone (what the SFU's `track` event does).
 * `window.__gain` sets how loud the tone is.
 */
async function injectRemoteTone(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as any
    const gen = new AudioContext()
    const osc = gen.createOscillator()
    const gain = gen.createGain()
    gain.gain.value = 0.2
    const dest = gen.createMediaStreamDestination()
    osc.connect(gain).connect(dest)
    osc.start()
    w.__gain = gain
    const a = new RTCPeerConnection()
    const b = new RTCPeerConnection()
    a.onicecandidate = (e) => e.candidate && void b.addIceCandidate(e.candidate)
    b.onicecandidate = (e) => e.candidate && void a.addIceCandidate(e.candidate)
    a.addTrack(dest.stream.getAudioTracks()[0] as MediaStreamTrack, dest.stream)
    const got = new Promise<MediaStream>((res) => {
      b.ontrack = (e) => res(new MediaStream([e.track]))
    })
    await a.setLocalDescription(await a.createOffer())
    await b.setRemoteDescription(a.localDescription as RTCSessionDescriptionInit)
    await b.setLocalDescription(await b.createAnswer())
    await a.setRemoteDescription(b.localDescription as RTCSessionDescriptionInit)
    const stream = await got
    const m = w.__meet
    m.watchLevel('ben', stream)
    m.set({ remote: { ...m.getView().remote, ben: { mic: stream } } })
  })
}

/** Screenshots at both widths, each taken while the bar is up (Chrome's fake microphone only makes a sound part of the time). */
async function shootLoud(page: Page, dir: string, label: string, scope: string): Promise<void> {
  for (const [w, h] of [
    [390, 844],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width: w, height: h })
    await sleep(400)
    await waitFor('the bar to be up', async () => (await level(page, scope)) > 55, 10_000).catch(() => {})
    await page.screenshot({ path: `${dir}/${label}-${w}.png` })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}

async function main(): Promise<void> {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true })
  // Talking, as far as a level bar can tell: the Self-check ignores Chrome's own fake beeps, as it should.
  const browser = await launch({ audioFile: speechLikeWav() })
  try {
    // 1. The level bar, in the lobby and on your own tile, with noise cancellation on and off.
    {
      const page = await openPage(browser)
      await ready(page)
      const lobby = await peakLevel(page, '[data-testid=lobby-level]')
      check(lobby > 15, 'the lobby level bar moves with the fake microphone (noise cancellation on)', `peak ${lobby} of 100`)
      const state = await audioState(page)
      check(state.ctx === 'running', 'the audio context is running in the lobby after the first tap', state.ctx)
      check(state.path === 'processed', 'the sound is sent through noise cancellation by default', state.path)
      if (SHOTS) {
        // A shot with the bar up: wait for a beep, then capture at both widths.
        await shootLoud(page, SHOTS, 'level-lobby', '[data-testid=lobby-level]')
      }

      await page.getByTestId('lobby-noise').evaluate((el) => (el as HTMLInputElement).click())
      await waitFor('noise cancellation off', async () => (await audioState(page)).path === 'graph', 5000)
      const raw = await peakLevel(page, '[data-testid=lobby-level]')
      check(raw > 15, 'the bar follows the raw microphone with noise cancellation off', `peak ${raw} of 100`)
      await page.getByTestId('lobby-noise').evaluate((el) => (el as HTMLInputElement).click())

      // 3a. The lobby's microphone picker.
      const picker = page.getByTestId('mic-select')
      const options = await picker.locator('option').count()
      check(options >= 2, "the lobby offers Chrome's fake microphones to choose from", `${options} options`)
      const before = (await audioState(page)).micId as string
      const other = await picker.locator('option').evaluateAll((opts, current) => (opts as HTMLOptionElement[]).map((o) => o.value).find((v) => v && v !== current), before)
      await picker.selectOption(other as string)
      await waitFor('the microphone to change', async () => (await audioState(page)).micId === other, 8000)
      check(true, 'choosing another microphone in the lobby switches to it', `${before.slice(0, 8)} to ${String(other).slice(0, 8)}`)
      const afterPick = await peakLevel(page, '[data-testid=lobby-level]')
      check(afterPick > 15, 'the level bar keeps moving after the switch', `peak ${afterPick}`)

      // In the call.
      await join(page)
      const live = await peakLevel(page, '[data-testid=tile-self]')
      check(live > 15, 'your own tile shows the level of what is sent', `peak ${live} of 100`)
      const s1 = await micSender(page)
      check(s1.hasSender && s1.isProcessed, 'the published microphone is the processed track', JSON.stringify(s1))
      if (SHOTS) {
        await shootLoud(page, SHOTS, 'level-call', '[data-testid=tile-self]')
      }

      // 3b. The picker in the call: another microphone, same published track.
      await page.getByTestId('ctl-input').click()
      const callPicker = page.getByTestId('mic-select')
      const idNow = (await audioState(page)).micId as string
      const another = await callPicker.locator('option').evaluateAll((opts, current) => (opts as HTMLOptionElement[]).map((o) => o.value).find((v) => v && v !== current), idNow)
      const published = (await micSender(page)).isProcessed
      await callPicker.selectOption(another as string)
      await waitFor('the microphone to change in the call', async () => (await audioState(page)).micId === another, 8000)
      const s2 = await micSender(page)
      check(published && s2.isProcessed && s2.readyState === 'live', 'switching microphone in the call keeps the same published track', JSON.stringify(s2))
      check((await peakLevel(page, '[data-testid=tile-self]')) > 15, 'and the level keeps moving')
      if (SHOTS) {
        await shootLoud(page, SHOTS, 'level-call-picker', '[data-testid=tile-self]')
      }
      await page.getByTestId('ctl-input').click()

      // Muting shows as an empty bar: what is sent is nothing.
      await page.getByTestId('ctl-mic').click()
      await sleep(400)
      check((await peakLevel(page, '[data-testid=tile-self]', 1500)) === 0, 'muted, the bar is empty (nothing is being sent)')
      await page.getByTestId('ctl-mic').click()
      await page.context().close()
    }

    // 2. The Self-check.
    for (const [fault, why] of [
      ['silent-worklet', 'a worklet that loads and outputs silence'],
      ['no-worklet', 'a worklet that cannot load'],
      ['suspended-context', 'an audio context that never starts'],
    ] as const) {
      const page = await openPage(browser, { fault })
      await ready(page)
      await waitFor('the fallback notice', async () => page.getByTestId('noise-notice').isVisible(), 15_000).catch(() => {})
      const notice = await page.getByTestId('noise-notice').isVisible()
      check(notice, `the lobby says noise cancellation could not start: ${why}`)
      if (notice && SHOTS && fault === 'silent-worklet') await shoot(page, SHOTS, 'fallback-lobby')
      const st = await audioState(page)
      check(st.path === 'direct' && st.fallback !== null, `the raw microphone is chosen: ${why}`, `${st.path}, ${st.fallback}`)
      check(
        (await page.getByTestId('lobby-noise').isEnabled()) && !(await page.getByTestId('lobby-noise').isChecked()),
        'and the noise switch is shown off, and can be tried again',
      )
      await join(page)
      await sleep(500)
      const s = await micSender(page)
      check(
        s.hasSender && s.isOutgoing && !s.isProcessed,
        'the call publishes the raw microphone track',
        JSON.stringify(s),
      )
      check(await page.getByTestId('noise-notice').isVisible(), 'and the call says so')
      check(
        (await page.getByTestId('ctl-noise').isEnabled()) && (await page.getByTestId('ctl-noise').getAttribute('aria-pressed')) === 'false',
        'with the noise button off, and enabled to try again',
      )
      if (fault === 'suspended-context') {
        // The context is asleep, so the analysers read nothing; the bar follows the sender's own statistics instead.
        const own = await peakLevel(page, '[data-testid=tile-self]', 5000)
        check(own > 15, 'your own bar is not blank while the audio context is asleep (it follows the sender)', `peak ${own} of 100`)
      }
      await page.context().close()
    }

    // 2b. The fall-back made in the call: the processed path works at first and then goes silent, so the
    // sender is swapped from the graph's track to the raw one while the call is up.
    {
      const page = await openPage(browser)
      await ready(page)
      await join(page)
      await waitFor('the microphone to be published', async () => (await micSender(page)).hasSender)
      const before = await micSender(page)
      check(before.isProcessed, 'before the fault the call publishes the processed track')
      // Break the graph under the call: the worklet's output no longer reaches the destination or the
      // meter, as if the worklet had died. The microphone is still there; what is sent is exactly silent.
      await page.evaluate(() => (window as any).__meet.o.audio.worklet.disconnect())
      await waitFor('the swap to the raw microphone', async () => !(await micSender(page)).isProcessed, 15_000)
      const after = await micSender(page)
      check(after.isOutgoing && after.readyState === 'live', 'a silent processed path in the call is swapped for the raw microphone with replaceTrack', JSON.stringify(after))
      check(await page.getByTestId('noise-notice').isVisible(), 'and the notice appears')
      check(
        (await page.getByTestId('noise-notice').innerText()).includes('stopped working'),
        'and says it stopped working (it had worked), not that it could not start',
      )
      // Switching noise cancellation on again tests the path: the worklet is wired back in, so this time it works.
      await page.getByTestId('ctl-noise').click()
      await waitFor('the processed track to be published again', async () => (await micSender(page)).isProcessed, 15_000)
      check(true, 'the noise switch after a fallback tests the path again and brings noise cancellation back')
      await sleep(6000)
      check(
        (await micSender(page)).isProcessed && !(await page.getByTestId('noise-notice').isVisible()),
        'and a path that works stays on, with the notice gone',
      )
      await page.context().close()
    }

    // 2c. The same switch on a path that is still dead: it falls back again, and the switch is still there.
    {
      const page = await openPage(browser, { fault: 'silent-worklet' })
      await ready(page)
      await waitFor('the first fallback', async () => (await audioState(page)).path === 'direct', 15_000)
      await page.getByTestId('lobby-noise').evaluate((el) => (el as HTMLInputElement).click())
      await waitFor('the path to be tried again', async () => (await audioState(page)).path === 'processed', 5000)
      await waitFor('the second fallback', async () => (await audioState(page)).path === 'direct', 15_000)
      check(
        (await page.getByTestId('noise-notice').isVisible()) && (await page.getByTestId('lobby-noise').isEnabled()),
        'switching noise cancellation on over a path that is still dead falls back again, and the switch stays usable',
      )
      await page.context().close()
    }

    // 2d. An audio context that stops mid-call (an iOS interruption) is left for the raw microphone, and when it
    // runs again for a second noise cancellation comes back by itself.
    {
      const page = await openPage(browser, { fault: 'resume-gate' })
      await ready(page)
      await join(page)
      await waitFor('the microphone to be published', async () => (await micSender(page)).isProcessed)
      await sleep(1500)
      await page.evaluate(() => {
        ;(window as any).__blockResume = true
        void (window as any).__meetAudio.context.suspend()
      })
      await waitFor('the swap to the raw microphone', async () => !(await micSender(page)).isProcessed, 15_000)
      const stopped = await page.getByTestId('noise-notice').innerText()
      check(stopped.includes('stopped working'), 'a context that stops mid-call is left for the raw microphone, and the notice says it stopped')
      await page.evaluate(() => {
        ;(window as any).__blockResume = false
        void (window as any).__meetAudio.context.resume()
      })
      await waitFor('noise cancellation to come back', async () => (await micSender(page)).isProcessed, 15_000)
      check(!(await page.getByTestId('noise-notice').isVisible()), 'once the context runs again, noise cancellation comes back by itself and the notice goes')
      await page.context().close()
    }

    // 2e. Safari holds the worklet's load until the context is tapped awake. The tap is listened for from the moment
    // the lobby opens, so a tap while the worklet loads lets it finish; with no tap at all, the pipeline gives up on
    // the worklet after about 3 s so that Join still comes up, and the switch can try again after a tap.
    {
      const page = await openPage(browser, { fault: 'waits-for-tap' })
      await page.getByPlaceholder('Guest').pressSequentially('Ana') // key presses are taps
      await waitFor('the Join button', async () => page.getByRole('button', { name: 'Join' }).isEnabled(), 15_000)
      const st = await audioState(page)
      check(st.path === 'processed', 'a tap while the worklet waits for the context lets it load: Join comes up with noise cancellation', st.path)
      await page.context().close()
    }
    {
      const page = await openPage(browser, { fault: 'waits-for-tap' })
      const started = Date.now()
      await waitFor('the Join button', async () => page.getByRole('button', { name: 'Join' }).isEnabled(), 15_000)
      const took = Date.now() - started
      const st = await audioState(page)
      check(st.path === 'direct' && st.fallback === 'unavailable', 'with no tap at all, the worklet is given up on and Join still comes up', `${st.path}, after ${took} ms`)
      check(took < 9000, 'within a few seconds', `${took} ms`)
      check(await page.getByTestId('noise-notice').isVisible(), 'with the notice shown')
      await page.getByTestId('lobby-noise').evaluate((el) => (el as HTMLInputElement).click()) // a tap
      await waitFor('noise cancellation to come up after the tap', async () => (await audioState(page)).path === 'processed', 15_000)
      check(true, 'and a tap on the noise switch then wakes the context and brings noise cancellation up')
      await page.context().close()
    }

    // 4. A remote person's level, and sound that does not arrive.
    {
      const page = await openPage(browser, { world: { ben: true } })
      await ready(page)
      await join(page)
      await page.getByTestId('tile').first().waitFor()
      await injectRemoteTone(page)
      const ben = '[data-testid=tile][data-member=ben]'
      await waitFor('Ben to be speaking', async () => (await page.locator(`${ben}[data-speaking=true]`).count()) > 0, 10_000)
      check(true, "a remote person's tile lights while their sound arrives")
      const heard = await level(page, ben)
      check(heard > 30, "and their level bar follows the received sound", `${heard} of 100`)
      check((await page.getByTestId('remote-sound').count()) === 1, 'a remote sound element is playing for them')
      if (SHOTS) await shoot(page, SHOTS, 'remote-speaking')
      await page.evaluate(() => ((window as any).__gain.gain.value = 0))
      await waitFor('Ben to stop speaking', async () => (await page.locator(`${ben}[data-speaking=false]`).count()) > 0, 5000)
      check(true, 'and the tile goes out when the sound stops')
      await page.context().close()
    }
    {
      const page = await openPage(browser, { world: { ben: true } })
      await ready(page)
      await join(page)
      const ben = page.locator('[data-testid=tile][data-member=ben]')
      await ben.waitFor()
      check((await ben.getByTestId('tile-not-arriving').count()) === 0, 'nobody is flagged in the first moments')
      await waitFor('the flag on Ben', async () => (await ben.getByTestId('tile-not-arriving').count()) > 0, 15_000)
      check(true, 'someone publishing sound that never arrives is flagged on their tile after about 5 s')
      if (SHOTS) await shoot(page, SHOTS, 'not-arriving')
      await page.context().close()
    }

    // 4b. A browser that refuses to start a remote sound until the person taps the banner.
    {
      const page = await openPage(browser, { world: { ben: true }, fault: 'autoplay-blocked' })
      await ready(page)
      await join(page)
      await page.getByTestId('tile').first().waitFor()
      await injectRemoteTone(page)
      await waitFor('the Tap to hear banner', async () => page.getByRole('button', { name: 'Tap to hear everyone' }).isVisible(), 10_000)
      check(true, 'a remote sound the browser refuses to start raises the Tap to hear banner')
      await page.getByRole('button', { name: 'Tap to hear everyone' }).click()
      await waitFor('the banner to go', async () => !(await page.getByRole('button', { name: 'Tap to hear everyone' }).isVisible()), 5000)
      check(await page.getByTestId('remote-sound').evaluate((el) => !(el as HTMLAudioElement).paused), 'a tap starts the sound and takes the banner away')
      await page.context().close()
    }

    // 5. The diagnostics panel behind ?debug=1, and a microphone the SFU refuses.
    {
      const page = await openPage(browser, { query: '?debug=1' })
      await ready(page)
      const lobbyDiag = await page.getByTestId('diag').innerText()
      check(/audio context\s+running/.test(lobbyDiag), '?debug=1 shows the audio context state in the lobby', lobbyDiag.split('\n')[1])
      await join(page)
      await waitFor('bytes out to show', async () => /bytes out \(audio\)\s+\d+/.test(await page.getByTestId('diag').innerText()), 8000)
      const callDiag = await page.getByTestId('diag').innerText()
      check(
        ['audio context', 'sending', 'sent track', 'mic ', 'bytes out', 'bytes in', 'browser'].every((k) => callDiag.includes(k)),
        '?debug=1 shows the context, path, sent track, microphone, bytes and browser in the call',
      )
      if (SHOTS) await shoot(page, SHOTS, 'diagnostics')
      await page.context().close()
    }
    {
      const page = await openPage(browser, { world: { refuseMic: true }, query: '?debug=1' })
      await ready(page)
      await join(page)
      await waitFor('the refusal notice', async () => page.getByTestId('mic-publish-failed').isVisible(), 10_000)
      check(true, 'a microphone the SFU refuses is said out loud to the person')
      check((await page.getByTestId('diag').innerText()).includes('publish failed'), 'and ?debug=1 lists it')
      await page.context().close()
    }
  } finally {
    await browser.close()
  }
  finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
