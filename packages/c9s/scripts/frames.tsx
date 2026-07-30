// Capture c9s UI states as PNGs you can actually look at.
//
//   bun run frames            # every state -> screenshots/<name>.png + all.png
//   bun run frames workers    # just the states whose name matches
//
// Boots the App against the demo fixture (no network, no token), replays
// keystrokes, grabs the rendered frame with its ANSI colour, renders it as
// HTML, and screenshots it with Playwright.
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { render } from 'ink-testing-library'
import { chromium } from 'playwright'
import { App } from '../src/app'
import { demoInstances, demoLoad, demoTail } from '../src/fixture'
import { ansiToHtml, framesPage } from './ansi-to-html'

/** One capture: a name, and the keys to press after boot. */
const STATES: { name: string; keys: string[] }[] = [
  { name: 'workers', keys: [] },
  { name: 'filter', keys: ['/', 'tour'] },
  { name: 'durable-objects', keys: ['3'] },
  { name: 'd1', keys: ['4'] },
  { name: 'r2', keys: ['5'] },
  { name: 'describe', keys: ['\r'] },
  { name: 'command', keys: [':'] },
  { name: 'cost', keys: [':', 'cost', '\r'] },
  { name: 'cost-describe', keys: [':', 'cost', '\r', '\r'] },
]

const OUT = join(dirname(new URL(import.meta.url).pathname), '..', 'screenshots')
const settle = () => new Promise((r) => setTimeout(r, 40))

async function capture(state: (typeof STATES)[number]) {
  const { lastFrame, stdin, unmount } = render(
    <App account="demo" load={demoLoad} instances={demoInstances} tail={demoTail} />,
  )
  await settle()
  for (const key of state.keys) {
    stdin.write(key)
    await settle()
  }
  const frame = lastFrame() ?? ''
  unmount()
  return { name: state.name, html: ansiToHtml(frame) }
}

const filter = process.argv[2]
const wanted = filter ? STATES.filter((s) => s.name.includes(filter)) : STATES
if (wanted.length === 0) {
  console.error(`no state matches "${filter}". known: ${STATES.map((s) => s.name).join(', ')}`)
  process.exit(1)
}

await mkdir(OUT, { recursive: true })
const frames = []
for (const state of wanted) frames.push(await capture(state))

const browser = await chromium.launch()
const page = await browser.newPage({ deviceScaleFactor: 2 })

for (const frame of frames) {
  await page.setContent(framesPage([frame]))
  const shot = join(OUT, `${frame.name}.png`)
  await page.locator('pre').screenshot({ path: shot })
  console.log(shot)
}

if (frames.length > 1) {
  await page.setContent(framesPage(frames))
  const all = join(OUT, 'all.png')
  await page.screenshot({ path: all, fullPage: true })
  console.log(all)
}

await browser.close()
