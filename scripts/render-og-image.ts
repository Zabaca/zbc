#!/usr/bin/env bun
/**
 * Render agentgit's link-preview card, once.
 *
 * The card is a committed asset (`packages/cli/templates/apps/walgit/assets/
 * agentgit-og.png`), not something the Worker draws per request: a crawler
 * fetching a picture must not wake the container any more than a reader
 * fetching the page does. So this script is a one-off — run it when the mark
 * or the wording changes, commit the PNG it writes, and the Worker serves
 * those bytes (`shared/og-image.ts`).
 *
 *   bun scripts/render-og-image.ts
 *
 * The mark is read from `assets/agentgit-mark.svg` rather than re-drawn here,
 * for the same reason the page keeps one `MARK_GEOMETRY`: a logo in two places
 * drifts. The palette and the type stacks are the landing page's own, so the
 * card and the page it previews look like one thing.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import {
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
} from '../packages/cli/templates/apps/walgit/shared/og-image'

const here = dirname(fileURLToPath(import.meta.url))
const assets = join(here, '..', 'packages', 'cli', 'templates', 'apps', 'walgit', 'assets')
const out = join(assets, 'agentgit-og.png')

const mark = readFileSync(join(assets, 'agentgit-mark.svg'), 'utf8')

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  :root {
    --ground: #14100e;
    --bone:   #ede6de;
    --muted:  #a79b90;
    --rule-2: #423831;
    --copper: #c56a3e;
    --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
    --serif: "Newsreader", Georgia, "Times New Roman", serif;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${OG_IMAGE_WIDTH}px; height: ${OG_IMAGE_HEIGHT}px; }
  body {
    background: var(--ground);
    color: var(--bone);
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2.5rem;
    padding: 0 6rem;
    /* The copper rule along the bottom is the page's own accent, and the only
       thing on the card that is not the mark or a word. */
    border-bottom: 10px solid var(--copper);
  }
  .mark { width: 168px; height: 168px; display: block; }
  h1 {
    font-family: var(--mono);
    font-size: 104px;
    letter-spacing: -.03em;
    font-weight: 700;
  }
  h1 .dot { color: var(--copper); }
  p {
    font-family: var(--serif);
    font-size: 42px;
    color: var(--muted);
    max-width: 26ch;
    /* Two balanced lines rather than one long one and a widow. */
    text-wrap: balance;
  }
  .foot {
    font-family: var(--mono);
    font-size: 26px;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--muted);
    border-top: 1px solid var(--rule-2);
    padding-top: 1.25rem;
  }
</style>
<body>
  ${mark.replace('<svg ', '<svg class="mark" ')}
  <div>
    <h1>agentgit<span class="dot">.</span></h1>
    <p>Git for AI agents. Push to a name and the repository exists.</p>
  </div>
  <div class="foot">No account · No token · Open source</div>
</body>`

const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT },
  // 1, deliberately: the card is specified at 1200×630 and a 2× raster is four
  // times the bytes for a picture every crawler downscales anyway.
  deviceScaleFactor: 1,
})
await page.setContent(html, { waitUntil: 'load' })
await page.screenshot({ path: out })
await browser.close()

console.log(`og card ${OG_IMAGE_WIDTH}x${OG_IMAGE_HEIGHT} → ${out}`)
