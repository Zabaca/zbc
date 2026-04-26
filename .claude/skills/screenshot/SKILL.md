---
name: screenshot
description: Capture screenshots of routes in the design-system viewer (or any local HTTP URL) for visual review. Two scripts — full-page and region-cropped — run via Bun + headless Chromium. Use when reviewing rendered output, comparing iterations, or providing visual evidence in a discussion. Do NOT use to inspect the Prose source HTML at .claude/design-sources/ — read that source directly.
user-invocable: true
---

Two scripts live next to this SKILL.md:

```
bun .claude/skills/screenshot/screenshot.ts <url> <out> [width=1280] [height=900]
bun .claude/skills/screenshot/screenshot-region.ts <url> <out> <x> <y> <w> <h> [vpW] [vpH]
```

Both run from the repo root, use Playwright + Chromium (already installed), wait for `networkidle`, and render at deviceScaleFactor 2.

## When to use which

- **Full-page** — first look at any new route, layout-level review, dark-mode comparison.
  ```
  bun .claude/skills/screenshot/screenshot.ts http://localhost:3000/ .claude/screenshots/index-light.png
  bun .claude/skills/screenshot/screenshot.ts http://localhost:3000/pages/prose .claude/screenshots/prose-page.png 1280 900
  ```

- **Region** — typography detail, hero crop, repeated comparison of the same area across iterations. Use when you need pixels you can actually read, not a thumbnail.
  ```
  bun .claude/skills/screenshot/screenshot-region.ts http://localhost:3000/ .claude/screenshots/hero-crop.png 0 0 1280 900
  ```

## Output convention

- Path: `.claude/screenshots/<route-or-component>-<descriptor>.png`. Examples: `index-light.png`, `index-dark.png`, `hero-crop.png`, `prose-pricing.png`.
- `.claude/screenshots/` is gitignored. Don't commit screenshots.

## Dev server gotchas (encoded from real failures)

- **Use Turbopack.** The dev script in `packages/design-system/package.json` is `bun --bun next dev viewer --turbopack`. Do not strip `--turbopack` — webpack-dev hangs silently at `Compiling /` with no error.
- **Don't restart casually.** Before any restart, run `pkill -f "next dev"; sleep 2` and confirm `lsof -i :3000` is empty. Otherwise multiple processes race on port 3000 and screenshots capture stale output.

## Don't

- Don't screenshot files under `.claude/design-sources/` to "see what they look like." Those are source references — read the HTML/CSS directly.
- Don't take a thumbnail-resolution full-page when you actually need to read typography. The full-page output is downsized when viewed; details are unreadable. Switch to region.

## v2 gaps to know about (not implemented)

- Element-targeted crops via Playwright `locator()` — currently you have to bisect y-coordinates to find a section.
- Computed-style inspection (`getComputedStyle()` for hex / font-family / sizes) — verifies tokens applied without eyeballing.

If a critique requires either, say so explicitly rather than guessing from a thumbnail.
