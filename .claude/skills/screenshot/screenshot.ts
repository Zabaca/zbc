#!/usr/bin/env bun
/* Screenshot a URL via headless Chromium. Used by the visual-review skill.
 * Usage: bun .claude/skills/screenshot/screenshot.ts <url> <out-path> [width] [height] */

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const [, , url = 'http://localhost:3000', out = '.claude/screenshots/page.png', wArg, hArg] =
  process.argv

const width = wArg ? Number(wArg) : 1280
const height = hArg ? Number(hArg) : 900

mkdirSync(dirname(out), { recursive: true })

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: 2,
})
const page = await context.newPage()
await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
await page.screenshot({ path: out, fullPage: true })
await browser.close()

console.log(`screenshot ${width}x${height} → ${out}`)
