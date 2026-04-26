#!/usr/bin/env bun
/* Screenshot a specific region of a URL via headless Chromium.
 * Usage: bun .claude/skills/screenshot/screenshot-region.ts <url> <out> <x> <y> <w> <h> [viewportW] [viewportH] */

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const args = process.argv.slice(2)
const [url, out, xs, ys, ws, hs, vws, vhs] = args
if (!url || !out || !xs || !ys || !ws || !hs) {
  console.error('Usage: screenshot-region.ts <url> <out> <x> <y> <w> <h> [vpW] [vpH]')
  process.exit(1)
}

const x = Number(xs)
const y = Number(ys)
const w = Number(ws)
const h = Number(hs)
const viewportW = vws ? Number(vws) : 1280
const viewportH = vhs ? Number(vhs) : Math.max(900, y + h + 100)

mkdirSync(dirname(out), { recursive: true })

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: viewportW, height: viewportH },
  deviceScaleFactor: 2,
})
const page = await context.newPage()
await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
await page.screenshot({ path: out, clip: { x, y, width: w, height: h } })
await browser.close()

console.log(`region screenshot ${w}x${h}@${x},${y} → ${out}`)
