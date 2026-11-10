// Seam 3c: the chat check. Real Chrome, the real page, the real Worker and Durable
// Objects, and an SFU that carries no media (src/dev-realtime.ts), so it needs no
// secrets and runs in a worktree.
//
//   FAKE_REALTIME=1 ALLOW_UNAUTHENTICATED=1 CLOUDFLARE_INCLUDE_PROCESS_ENV=true bun run dev   (packages/meet)
//   bun scripts/chat.ts [--base http://localhost:4812] [--shots <dir>] [--chrome <path>]
//
// It checks that two tabs exchange messages with names and times, that a link is a
// real link that opens in a new tab with rel="noopener noreferrer nofollow", that
// markup shows as text and runs nothing, that the unread badge counts what others
// say while the panel is closed and not what was already there when you arrived, that
// someone who joins late sees the messages so far, that a lookalike-letter link shows
// the address it really opens, that your own messages stay yours after you leave and
// come back as a new Member, that the lobby tells guests the chat is saved, that the
// phone's sheet sits above the controls bar at its real height, that the length and
// the rate are limited. (The past calls list, its saved chat and deleting it were /start's;
// they are the space's now, and its own checks cover them.)

import { mkdirSync } from 'node:fs'
import type { BrowserContext, Page } from 'playwright'
import { BASE, SHOTS, check, finish, launch, shoot, sleep, waitFor } from './harness'

const SAVED = 'Messages in this chat are saved.'
let told = false

async function join(context: BrowserContext, url: string, name: string): Promise<Page> {
  const page = await context.newPage()
  page.on('pageerror', (e) => console.log(`  [${name} page error] ${e.message}`))
  await page.goto(url)
  await page.getByPlaceholder('Guest').fill(name)
  if (!told) {
    told = true
    const notice = await page.getByTestId('lobby-chat-notice').innerText()
    check(notice === `This call has a chat. ${SAVED}`, 'the lobby tells guests the chat is saved, before they join', notice)
  }
  await waitFor('the Join button', async () => page.getByRole('button', { name: 'Join' }).isEnabled(), 30_000)
  await page.getByRole('button', { name: 'Join' }).click()
  await page.getByTestId('count').waitFor({ timeout: 30_000 })
  return page
}

const openChat = async (page: Page) => {
  await page.getByTestId('ctl-chat').click()
  await page.getByTestId('chat').waitFor()
}
const texts = (page: Page): Promise<string[]> => page.locator('[data-testid=chat] [data-testid=message] .msg-text').allInnerTexts()
const send = async (page: Page, text: string) => {
  await page.getByTestId('chat-input').fill(text)
  await page.getByTestId('chat-input').press('Enter')
}
const unread = async (page: Page): Promise<number> => {
  const el = page.getByTestId('ctl-chat-badge')
  return (await el.count()) === 0 ? 0 : Number.parseInt((await el.innerText()).replace('+', ''), 10)
}

async function main(): Promise<void> {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true })
  const browser = await launch()
  try {
    // A call, made through the development route (a localhost run with the bypass only; the space makes them in production).
    const started = await fetch(`${BASE}/api/dev/rooms`, { method: 'POST' })
    check(started.status === 201, 'a call can be started', `status ${started.status}`)
    const { name: room } = (await started.json()) as { name: string }
    const url = `${BASE}/r/${room}`
    const mk = () => browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] })
    const [ctxA, ctxB] = [await mk(), await mk()]

    const ana = await join(ctxA, url, 'Ana')
    const ben = await join(ctxB, url, 'Ben')
    await waitFor('two in the call', async () => (await ana.getByTestId('count').innerText()).startsWith('2'))

    // 1. The panel, the notice, a message each way.
    await openChat(ana)
    check((await ana.getByTestId('chat-saved').innerText()) === SAVED, 'the panel says the messages are saved')
    check(await ana.getByTestId('chat-empty').isVisible(), 'and starts empty')
    await send(ana, 'hello Ben')
    await waitFor('your own message', async () => (await texts(ana)).includes('hello Ben'), 8000)
    const own = ana.locator('[data-testid=message]').first()
    check(
      (await own.locator('.msg-name').innerText()) === 'Ana' && /\d{1,2}:\d{2}/.test(await own.locator('time').innerText()),
      'a message shows its sender and the time',
      await own.locator('time').innerText(),
    )
    await waitFor('the badge on Ben', async () => (await unread(ben)) === 1, 10_000)
    check(true, 'the other tab shows an unread badge while its panel is closed', `badge ${await unread(ben)}`)
    if (SHOTS) await shoot(ben, SHOTS, 'chat-badge')
    await openChat(ben)
    check((await texts(ben)).includes('hello Ben'), 'and opening the panel shows the message')
    check((await ben.locator('[data-testid=message] .msg-name').first().innerText()) === 'Ana', "with the sender's name")
    check((await unread(ben)) === 0, 'the badge clears when the panel is open')
    await send(ben, 'hi Ana, notes at https://example.com/notes?a=1&b=2.')
    await waitFor('Ben message on Ana', async () => (await texts(ana)).length === 2, 10_000)

    // 2. Links are links; markup is text.
    const link = ana.locator('[data-testid=chat] .msg-text a')
    check((await link.count()) === 1, 'an address in a message is a link')
    check(
      (await link.getAttribute('href')) === 'https://example.com/notes?a=1&b=2' &&
        (await link.getAttribute('target')) === '_blank' &&
        (await link.getAttribute('rel')) === 'noopener noreferrer nofollow',
      'it opens in a new tab with rel="noopener noreferrer nofollow", and the full stop is not part of it',
      `${await link.getAttribute('href')} ${await link.getAttribute('rel')}`,
    )
    await send(ana, '<img src=x onerror="window.__xss=1"> <b>bold</b> javascript:alert(1)')
    await waitFor('the markup message on Ben', async () => (await texts(ben)).length === 3, 10_000)
    const shown = (await texts(ben))[2]
    check(
      shown === '<img src=x onerror="window.__xss=1"> <b>bold</b> javascript:alert(1)' &&
        (await ben.locator('[data-testid=chat] img, [data-testid=chat] .msg-text b').count()) === 0 &&
        !(await ben.evaluate(() => (window as any).__xss)),
      'markup is shown as typed, makes no element and runs nothing',
    )
    check((await ben.locator('[data-testid=chat] .msg-text a').count()) === 1, 'and javascript: is not a link (only the earlier address is)')
    await send(ana, 'not apple: https://\u0430pple.example/login')
    await waitFor('the lookalike message on Ben', async () => (await texts(ben)).length === 4, 10_000)
    const lookalike = ben.locator('[data-testid=chat] .msg-text a').last()
    check(
      (await lookalike.innerText()) === 'https://xn--pple-43d.example/login' && (await lookalike.getAttribute('href')) === 'https://xn--pple-43d.example/login',
      'a lookalike-letter link shows the address it really opens, not the letters that mimic apple.com',
      await lookalike.innerText(),
    )
    if (SHOTS) {
      await shoot(ana, SHOTS, 'chat-panel')
      await shoot(ben, SHOTS, 'chat-panel-guest')
    }

    // The phone's sheet sits above the controls bar, whatever height the bar has (it wraps on a narrow screen).
    for (const [w, h] of [
      [390, 844],
      [320, 640],
    ] as const) {
      await ana.setViewportSize({ width: w, height: h })
      await sleep(500)
      const box = await ana.evaluate(() => {
        const sheet = (document.querySelector('[data-testid=chat]') as HTMLElement).getBoundingClientRect()
        const bar = (document.querySelector('.controls') as HTMLElement).getBoundingClientRect()
        return { sheetBottom: sheet.bottom, barTop: bar.top, barHeight: bar.height, sheetHeight: sheet.height }
      })
      check(
        Math.abs(box.sheetBottom - box.barTop) <= 1 && box.sheetHeight > 150,
        `at ${w}px the chat sheet ends exactly where the controls bar begins`,
        `bar ${Math.round(box.barHeight)}px tall, sheet bottom ${Math.round(box.sheetBottom)}, bar top ${Math.round(box.barTop)}`,
      )
      if (SHOTS && w === 320) await ana.screenshot({ path: `${SHOTS}/chat-sheet-controls-320.png` })
    }
    await ana.setViewportSize({ width: 1440, height: 900 })

    // 3. Someone who joins late sees the messages so far, and none of them counts as unread.
    const cy = await join(await mk(), url, 'Cy')
    await waitFor('Cy to see the call', async () => (await cy.getByTestId('count').innerText()).startsWith('3'))
    await sleep(2500) // the first check-in that carries the history
    check((await unread(cy)) === 0, 'history is not unread for someone who joins late')
    await openChat(cy)
    const history = await texts(cy)
    check(history.length === 4 && history[0] === 'hello Ben', 'a late joiner sees the call\'s messages so far, in order', `${history.length} messages`)
    await send(cy, 'sorry I am late')
    await waitFor('Cy message on Ana', async () => (await texts(ana)).length === 5, 10_000)

    // 3b. A person dropped from the call and let back in is a new Member; their earlier messages are still theirs.
    await send(cy, 'sent before I left')
    await waitFor('Cy message on Ana', async () => (await texts(ana)).length === 6, 10_000)
    await cy.getByTestId('ctl-leave').click()
    await cy.getByRole('button', { name: 'Rejoin' }).click() // reloads: same token, a new seat, a new Member id
    await cy.getByRole('button', { name: 'Join' }).click()
    await cy.getByTestId('count').waitFor({ timeout: 30_000 })
    await sleep(3000)
    check((await unread(cy)) === 0, 'history is still not unread after leaving and coming back')
    await openChat(cy)
    const mine = await cy.locator('[data-testid=chat] .msg-self .msg-text').allInnerTexts()
    check(mine.includes('sent before I left') && mine.includes('sorry I am late'), 'your own earlier messages are still yours after coming back as a new Member', mine.join(' | '))

    // 4. The limits: the length in the box, the length and the rate at the server.
    check((await ana.getByTestId('chat-input').getAttribute('maxlength')) === '2000', 'the box holds 2,000 characters at most')
    const tooLong = await ana.evaluate(async () => {
      const m = (window as any).__meet
      const token = sessionStorage.getItem(Object.keys(sessionStorage).find((k) => k.startsWith('meet.token.')) as string)
      const res = await fetch(`${location.pathname.replace('/r/', '/r/api/rooms/')}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-member-token': token as string },
        body: JSON.stringify({ generation: m.gen, text: 'x'.repeat(2001) }),
      })
      return res.status
    })
    check(tooLong === 400, 'the server refuses a message over 2,000 characters', `status ${tooLong}`)
    // Send until the limit stops it (at most 6 in a window, so 12 is more than enough even across a window's end).
    const results: boolean[] = []
    for (let i = 0; i < 12 && results.at(-1) !== false; i++) results.push(await ana.evaluate((n) => (window as any).__meet.sendChat(`burst ${n}`), i))
    check(results.at(-1) === false && results.length <= 12, 'a burst of messages is stopped by the rate limit', results.map((r) => (r ? 'ok' : 'x')).join(''))
    await waitFor('the error on Ana', async () => ana.getByTestId('chat-error').isVisible(), 5000)
    check((await ana.getByTestId('chat-error').innerText()).includes('too fast'), 'and the person is told, in words')
    await ana.getByTestId('chat-input').fill('kept while refused')
    await ana.getByTestId('chat-input').press('Enter')
    await sleep(500)
    check((await ana.getByTestId('chat-input').inputValue()) === 'kept while refused', 'a refused message stays in the box, not lost', `box: "${await ana.getByTestId('chat-input').inputValue()}"`)
    await ana.getByTestId('chat-input').fill('')

    for (const p of [ana, ben, cy]) await p.getByTestId('ctl-leave').click()

    // 5. A name nobody started is not a call, and chat on it creates nothing.
    const ghost = 'a'.repeat(20)
    const sent = await fetch(`${BASE}/r/api/rooms/${ghost}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-member-token': 'g'.repeat(24) },
      body: JSON.stringify({ generation: 1, text: 'hi' }),
    })
    const lobby = await fetch(`${BASE}/r/api/rooms/${ghost}`)
    check(sent.status === 404 && lobby.status === 404, 'a name nobody started takes no message and is not a call')
  } finally {
    await browser.close()
  }
  finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
