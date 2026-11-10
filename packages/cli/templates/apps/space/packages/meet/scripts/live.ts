// Seam 3: the live two-browser check, against the real SFU.
//
//   bun run dev                       (packages/meet, with .dev.vars made from sops as README shows)
//   bun scripts/live.ts [--base http://localhost:4812] [--shots <dir>] [--video <file.mjpeg|y4m>] [--chrome <path>]
//
// Drives Chrome with its fake camera and microphone. It checks that:
//   1. two tabs connect and each one's received audio and video packets keep rising,
//   2. noise cancellation and blur can be switched on without the call dropping, and the level
//      bar on your own tile moves with the fake microphone,
//   3. a fake screen share appears in the other tab and its frames keep arriving,
//   4. a tab that forces the relay connects over a relay pair,
//   5. stopping the share and leaving take the picture and the person off the other tab,
//   7. when noise cancellation cannot work (the worklet cannot load, or loads and says nothing),
//      the tab sends the raw microphone, says so, and the other tab still receives its audio.
// (What the sound features do on one side of the wire, without the SFU, is scripts/audio.ts.)
// It uses a few MB of the free allowance. With --shots it also writes screenshots
// at 390px and 1440px of the lobby, a call with 2 people, blur on and a share.

import { mkdirSync } from 'node:fs'
import type { BrowserContext, Page } from 'playwright'
import {
  BASE,
  NO_WORKLET,
  SHOTS,
  SILENT_WORKLET,
  check,
  finish,
  launch,
  micSender,
  peakLevel,
  shoot,
  sleep,
  speechLikeWav,
  waitFor,
} from './harness'

interface Stats {
  sentVideoBytes: number
  sentAudioBytes: number
  recvVideoPackets: number
  recvAudioPackets: number
  recvAudioBytes: number
  recvScreenFrames: number
  link: string
}

/** Bytes of one member's microphone this tab has received (the controller polls once a second). */
const inboundBytes = (page: Page, memberId: string): Promise<number> =>
  page.evaluate((id) => (window as any).__meet.getAudioStats().inbound[id] ?? 0, memberId)

/** True once that member's sound has come in by at least `by` bytes within a few seconds. */
async function hears(page: Page, memberId: string, by = 3000): Promise<boolean> {
  const first = await inboundBytes(page, memberId)
  return waitFor(`audio from ${memberId} to rise`, async () => ((await inboundBytes(page, memberId)) >= first + by ? true : false), 20_000).catch(
    () => false,
  )
}

const selfId = (page: Page): Promise<string> => page.evaluate(() => (window as any).__meet.getView().selfId)

const stats = (page: Page): Promise<Stats> => page.evaluate(() => (window as any).__meet.debugStats())

/** True once the packet counter `key` has grown by at least `by` within a few seconds. */
async function rises(page: Page, key: keyof Stats, by = 20): Promise<boolean> {
  const first = (await stats(page))[key] as number
  return waitFor(`${key} to rise`, async () => (((await stats(page))[key] as number) >= first + by ? true : false), 15_000).catch(
    () => false,
  )
}

async function open(context: BrowserContext, url: string, name: string, shotsDir?: string): Promise<Page> {
  const page = await context.newPage()
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`  [${name} ${m.type()}] ${m.text().slice(0, 200)}`)
  })
  await page.goto(url)
  await page.getByPlaceholder('Guest').fill(name)
  await waitFor('the lobby camera', async () =>
    page.evaluate(
      () =>
        (document.querySelector('.preview video') as HTMLVideoElement | null)?.readyState === 4 ||
        (document.querySelector('.preview video') as HTMLVideoElement | null)?.videoWidth! > 0,
    ),
  )
  if (shotsDir) {
    await shoot(page, shotsDir, 'lobby')
    await page.setViewportSize({ width: 1440, height: 900 })
  }
  await page.getByRole('button', { name: 'Join' }).click()
  await page.getByTestId('count').waitFor({ timeout: 30_000 })
  return page
}

async function main(): Promise<void> {
  const browser = await launch()
  if (SHOTS) mkdirSync(SHOTS, { recursive: true })
  try {
    // A call, made through the development route (a localhost run with the bypass only; the space makes them in production).
    const started = await fetch(`${BASE}/api/dev/rooms`, { method: 'POST' })
    check(started.status === 201, 'a call can be started', `status ${started.status}`)
    const { name } = (await started.json()) as { name: string }
    const url = `${BASE}/r/${name}`

    if (SHOTS) {
      // The page a stranger gets.
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      const p = await ctx.newPage()
      await p.goto(`${BASE}/`)
      await shoot(p, SHOTS, 'home')
      await ctx.close()
    }

    const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] })
    const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] })

    const a = await open(ctxA, url, 'Ana', SHOTS)
    const b = await open(ctxB, url, 'Ben')

    // 1. Two tabs connect and media flows both ways.
    await waitFor('two in the call on both tabs', async () => {
      const counts = await Promise.all([a, b].map((p) => p.getByTestId('count').innerText()))
      return counts.every((c) => c.startsWith('2'))
    })
    check(true, 'both tabs see two people in the call')
    await waitFor('both tiles to have video', async () =>
      (
        await Promise.all(
          [a, b].map((p) =>
            p.evaluate(() =>
              [...document.querySelectorAll('[data-testid=tile] video')].some((v) => (v as HTMLVideoElement).videoWidth > 0),
            ),
          ),
        )
      ).every(Boolean),
    )
    check(true, "each tab shows the other person's video")
    for (const [label, page] of [
      ['Ana', a],
      ['Ben', b],
    ] as const) {
      check(await rises(page, 'recvVideoPackets'), `${label} keeps receiving video packets`)
      check(await rises(page, 'recvAudioPackets'), `${label} keeps receiving audio packets`)
    }
    await waitFor('a connection badge', async () => (await a.getByTestId('link-badge').innerText()) !== 'Connecting', 15_000).catch(
      () => {},
    )
    console.log(`  badge: Ana ${await a.getByTestId('link-badge').innerText()}, Ben ${await b.getByTestId('link-badge').innerText()}`)
    if (SHOTS) await shoot(a, SHOTS, 'call-2')

    // 2. Noise cancellation off and on, and blur on, without the call dropping.
    // Chrome's fake microphone beeps; RNNoise treats a steady tone as noise, so the sound that is
    // published should be much quieter with the effect on than off. This reads the published track itself.
    const level = () =>
      a.evaluate(async () => {
        const track = (window as any).__meet.o.audio.outgoing as MediaStreamTrack
        const ctx = new AudioContext()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 2048
        ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser)
        const buf = new Float32Array(analyser.fftSize)
        let peak = 0
        for (let i = 0; i < 80; i++) {
          await new Promise((r) => setTimeout(r, 50))
          analyser.getFloatTimeDomainData(buf)
          peak = Math.max(peak, Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length))
        }
        await ctx.close()
        return peak
      })
    const withNoise = await level()
    await a.getByTestId('ctl-noise').click()
    check((await a.getByTestId('ctl-noise').getAttribute('aria-pressed')) === 'false', 'noise cancellation switches off')
    const without = await level()
    check(
      without > withNoise * 1.3,
      'the published sound is quieter with noise cancellation on (fake beeps are treated as noise)',
      `peak level ${withNoise.toFixed(4)} on, ${without.toFixed(4)} off`,
    )
    // With it off, what is sent is the microphone itself, and the level bar on the tile follows it.
    const barOff = await peakLevel(a, '[data-testid=tile-self]')
    check(barOff > 20, "the level bar on your own tile moves with Chrome's fake microphone", `peak ${barOff} of 100`)
    await a.getByTestId('ctl-noise').click()
    check(await rises(b, 'recvAudioPackets'), 'audio keeps flowing after noise cancellation is switched off and on')
    const before = (await stats(b)).recvVideoPackets
    await a.getByTestId('ctl-blur').click()
    await waitFor('blur to be on', async () => (await a.getByTestId('ctl-blur').getAttribute('aria-pressed')) === 'true', 60_000)
    check(true, 'blur switched on')
    check(await rises(b, 'recvVideoPackets', 30), 'video keeps flowing to the other tab with blur on', `from ${before}`)
    await sleep(1500)
    if (SHOTS) await shoot(a, SHOTS, 'blur-on')
    await a.getByTestId('ctl-blur').click()
    await waitFor('blur to be off', async () => (await a.getByTestId('ctl-blur').getAttribute('aria-pressed')) === 'false', 20_000)
    check(await rises(b, 'recvVideoPackets', 30), 'video keeps flowing after blur is switched off')
    await a.getByTestId('ctl-blur').click()
    await waitFor('blur to be on again', async () => (await a.getByTestId('ctl-blur').getAttribute('aria-pressed')) === 'true', 30_000)

    // 2b. Mute and camera-off show to the other tab, and the camera comes back.
    await a.getByTestId('ctl-mic').click()
    await waitFor(
      'the muted mark on Ben',
      async () =>
        b
          .locator('[data-testid=tile] .mark')
          .count()
          .then((n) => n > 0),
      15_000,
    )
    check(true, 'a muted microphone shows to the other tab')
    await a.getByTestId('ctl-mic').click()
    await a.getByTestId('ctl-camera').click()
    await waitFor(
      'the avatar on Ben',
      async () =>
        b
          .locator('[data-testid=tile] .avatar')
          .count()
          .then((n) => n > 0),
      15_000,
    )
    check(true, 'a camera that is off shows as a name to the other tab')
    check(await rises(b, 'recvVideoPackets', 3), 'the placeholder keeps the camera publication alive while the camera is off')
    await a.getByTestId('ctl-camera').click()
    await waitFor(
      'the picture back on Ben',
      async () =>
        b
          .locator('[data-testid=tile] .avatar')
          .count()
          .then((n) => n === 0),
      20_000,
    )
    check(await rises(b, 'recvVideoPackets', 30), 'turning the camera back on brings the picture back')

    // 3. A screen share appears in the other tab, and stops.
    await a.getByTestId('ctl-share').click()
    await waitFor(
      'the share to appear on Ben',
      async () =>
        b
          .locator('.share-video')
          .count()
          .then((n) => n > 0),
      30_000,
    )
    check(true, 'a screen share appears in the other tab')
    await waitFor(
      'share frames',
      async () => b.evaluate(() => ((document.querySelector('.share-video') as HTMLVideoElement | null)?.videoWidth ?? 0) > 0),
      20_000,
    )
    check(true, 'the shared screen has a picture')
    await sleep(1500)
    if (SHOTS) await shoot(b, SHOTS, 'share')
    await a.getByTestId('ctl-share').click()
    await waitFor(
      'the share to go',
      async () =>
        b
          .locator('.share-video')
          .count()
          .then((n) => n === 0),
      20_000,
    )
    check(true, 'stopping the share takes it off the other tab')
    // Sharing again is a new publication and works.
    await a.getByTestId('ctl-share').click()
    await waitFor(
      'the second share',
      async () =>
        b
          .locator('.share-video')
          .count()
          .then((n) => n > 0),
      30_000,
    )
    check(true, 'sharing again works')
    await a.getByTestId('ctl-share').click()
    await waitFor(
      'the second share to go',
      async () =>
        b
          .locator('.share-video')
          .count()
          .then((n) => n === 0),
      20_000,
    )

    // 4. A tab that forces the relay connects over a relay pair.
    const ctxC = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] })
    const c = await open(ctxC, `${url}?relay=1`, 'Cy')
    await waitFor('three in the call', async () => (await c.getByTestId('count').innerText()).startsWith('3'))
    await waitFor('the relayed badge', async () => (await c.getByTestId('link-badge').innerText()) === 'Relayed', 30_000)
    check(true, 'a forced-relay tab connects over a relay pair', 'badge says Relayed')
    check(await rises(c, 'recvVideoPackets'), 'the relayed tab receives video')

    // 5. Leaving takes the person off the other tabs.
    await c.getByTestId('ctl-leave').click()
    await waitFor('Cy to leave', async () => (await a.getByTestId('count').innerText()).startsWith('2'), 15_000)
    check(true, 'a person who leaves disappears from the others')

    // 5a. A tab that stops checking in but keeps its connection open is cut off at the SFU once it is dropped.
    const ctxD = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] })
    const dee = await open(ctxD, url, 'Dee')
    await waitFor('three in the call', async () => (await a.getByTestId('count').innerText()).startsWith('3'))
    check(await rises(dee, 'recvVideoPackets'), 'before it is blocked, the tab receives video')
    await dee.route('**/api/rooms/*/checkin', (route) => route.abort())
    await waitFor('Dee to drop off the grid', async () => (await a.getByTestId('count').innerText()).startsWith('2'), 70_000)
    check(true, "a tab whose check-ins are blocked drops off the other tab's grid")
    await sleep(5000) // the close is made at the next check-in by anyone; give it, and packets in flight, time
    const quiet1 = (await stats(dee)).recvVideoPackets
    await sleep(6000)
    const quiet2 = (await stats(dee)).recvVideoPackets
    check(
      quiet2 - quiet1 <= 3,
      'the dropped tab stops receiving media (its connection is still open)',
      `${quiet2 - quiet1} packets in 6 s, against hundreds before`,
    )
    await ctxD.close()

    // 5b. A dropped connection comes back by itself: both peer connections are rebuilt under a new generation.
    await b.evaluate(() => (window as any).__meet.reconnect(false))
    await waitFor('Ben to be live again', async () => b.evaluate(() => (window as any).__meet.getView().phase === 'live'), 30_000)
    check(await rises(b, 'recvVideoPackets'), 'after a forced reconnect the tab receives video again')
    check(await rises(a, 'recvVideoPackets'), 'after the other tab reconnects, this one still receives its video')
    check((await a.getByTestId('count').innerText()).startsWith('2'), 'a reconnect does not duplicate the person')

    // 5c. A check-in that is still in flight when the tab reconnects reaches the server after the join has
    // bumped the generation but before the join's reply has come back to the tab, so the tab still holds the
    // old one. The 409 it gets is stale, not a second window, and must not end the call.
    let held = false
    await b.route('**/api/rooms/*/checkin', async (route) => {
      held = true
      await sleep(1500)
      await route.continue().catch(() => {})
    })
    await b.route('**/api/rooms/*/join', async (route) => {
      const response = await route.fetch() // the server has moved on now
      await sleep(2500) // and the tab hears about it late
      await route.fulfill({ response })
    })
    // The call is ended for a moment by the bug and then put back by the reconnect, so watch for the moment.
    await b.evaluate(() => {
      const w = window as any
      w.__everEnded = false
      w.__meet.subscribe(() => {
        if (w.__meet.getView().phase === 'ended') w.__everEnded = true
      })
    })
    await waitFor('a check-in in flight', async () => held, 10_000)
    await b.evaluate(() => (window as any).__meet.reconnect(false))
    await waitFor('Ben to be live again', async () => b.evaluate(() => (window as any).__meet.getView().phase === 'live'), 30_000)
    await sleep(3000)
    const phase = await b.evaluate(() => (window as any).__meet.getView().phase)
    const everEnded = await b.evaluate(() => (window as any).__everEnded)
    check(
      phase === 'live' && !everEnded,
      'a check-in held in flight across a reconnect does not end the call',
      `phase ${phase}, ended at some point: ${everEnded}`,
    )
    check(await rises(a, 'recvVideoPackets'), 'and the tab is still sending its camera afterwards')
    await b.unroute('**/api/rooms/*/checkin')
    await b.unroute('**/api/rooms/*/join')

    // 7a. A tab whose noise-cancellation worklet cannot load sends the raw microphone and says so, and the
    // other tab still receives its audio.
    const ctxE = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] })
    await ctxE.addInitScript(NO_WORKLET)
    const eve = await open(ctxE, url, 'Eve')
    await waitFor('three in the call', async () => (await a.getByTestId('count').innerText()).startsWith('3'))
    check(await eve.getByTestId('noise-notice').isVisible(), 'a tab whose worklet cannot load says noise cancellation could not start')
    await waitFor('the microphone to be published', async () => (await micSender(eve)).hasSender)
    const eveSend = await micSender(eve)
    check(eveSend.isOutgoing && !eveSend.isProcessed, 'and publishes the raw microphone track', JSON.stringify(eveSend))
    const eveId = await selfId(eve)
    check(await hears(a, eveId), "the other tab still receives that tab's audio", `member ${eveId.slice(0, 6)}`)
    check((await a.locator('[data-testid=tile] [data-testid=tile-not-arriving]').count()) === 0, 'and flags nobody as silent')
    await eve.getByTestId('ctl-leave').click()
    await waitFor('Eve to leave', async () => (await a.getByTestId('count').innerText()).startsWith('2'), 15_000)
    await ctxE.close()

    // 7b. A worklet that loads and then outputs silence: the call starts on the processed track, notices after
    // about 2 s of speech going in and nothing coming out, and swaps to the raw microphone with replaceTrack.
    // Chrome's own fake beep is not speech to the Self-check, so this tab's microphone plays a speech-like file.
    const talker = await launch({ audioFile: speechLikeWav() })
    try {
      const ctxF = await talker.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] })
      await ctxF.addInitScript(SILENT_WORKLET)
      const fay = await open(ctxF, url, 'Fay')
      await waitFor('three in the call', async () => (await a.getByTestId('count').innerText()).startsWith('3'))
      await waitFor('the microphone to be published', async () => (await micSender(fay)).hasSender)
      await waitFor('the swap to the raw microphone', async () => !(await micSender(fay)).isProcessed, 30_000)
      const faySend = await micSender(fay)
      check(faySend.isOutgoing && faySend.readyState === 'live', 'a worklet that outputs silence is swapped for the raw microphone', JSON.stringify(faySend))
      check(await fay.getByTestId('noise-notice').isVisible(), 'and the tab says so')
      const fayId = await selfId(fay)
      check(await hears(a, fayId), "the other tab receives that tab's audio after the swap", `member ${fayId.slice(0, 6)}`)
      await waitFor(
        "Fay's tile on the other tab to light while she talks",
        async () => (await a.locator(`[data-testid=tile][data-member="${fayId}"][data-speaking=true]`).count()) > 0,
        20_000,
      )
      check(true, "and the speaking light on that person's tile follows the sound that arrives")
      await fay.getByTestId('ctl-leave').click()
      await waitFor('Fay to leave', async () => (await a.getByTestId('count').innerText()).startsWith('2'), 15_000)
      await ctxF.close()
    } finally {
      await talker.close()
    }

    // 6. A refresh lands back as the same person.
    await b.reload()
    await b.getByRole('button', { name: 'Join' }).click()
    await b.getByTestId('count').waitFor({ timeout: 30_000 })
    await sleep(3000)
    check((await a.getByTestId('count').innerText()).startsWith('2'), 'a refresh does not duplicate the person')
    check(await rises(b, 'recvVideoPackets'), 'the refreshed tab receives video again')
  } finally {
    await browser.close()
  }
  finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
