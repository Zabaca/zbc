---
name: visual-review
description: Audit rendered output against the Prose design system's rules. Captures the touched routes at three widths × two themes via the screenshot skill, then walks a fixed checklist (token drift, accent budget, typography, spacing, manifesto adherence) and reports divergences with proposed fixes. Use after a Mode B change, after a token rename, before declaring a component "done", or whenever something looks off.
user-invocable: true
---

Visual-review is a *verification pass*, not an implementation pass. Mode B's per-step screenshot is "did my one change render correctly?"; visual-review is "does this component (or page) actually conform to the design system's rules?"

It is checklist-driven. The point is to catch things you would not catch by reading the diff: a fourth accent use, a spacing inconsistency between sections, a token that didn't propagate, a hover state that collapses in dark mode.

## When to run

- After a multi-step migration touching multiple components (e.g. the 13-phase Tailwind v4 migration).
- After a token rename or color rebalance — these ripple invisibly.
- Before marking a TaskList task complete that says anything like "render correctly" or "match design".
- When the user says something looks off and you can't immediately see why.
- Periodically during long sessions — drift accumulates.

## Capture matrix

Default sweep, per route under review:

| Width | Theme | Why |
|---|---|---|
| 1280 | light | desktop default — most users |
| 1280 | dark   | dark-mode parity check |
| 900  | light | tablet / collapsed columns |
| 500  | light | mobile single-column |

If the change is layout/responsive: all four. If it's color/typography only: 1280 light + dark is enough.

```bash
# Restart dev to flush stale state, then capture.
pkill -f "astro|vite"; sleep 1
cd packages/design-system && bun run dev &
sleep 3

bun scripts/screenshot.ts http://localhost:3000/<route> .claude/screenshots/<name>-1280-light.png 1280 900
bun scripts/screenshot.ts http://localhost:3000/<route> .claude/screenshots/<name>-1280-dark.png 1280 900
# (toggle theme via the sidebar between captures, or add a wrapper that sets .dark on <html>)
bun scripts/screenshot.ts http://localhost:3000/<route> .claude/screenshots/<name>-900-light.png 900 1200
bun scripts/screenshot.ts http://localhost:3000/<route> .claude/screenshots/<name>-500-light.png 500 1400
```

See `.claude/skills/screenshot/SKILL.md` for script details and gotchas.

## Checklist (walk in order)

For each captured screenshot, check:

### 1. Manifesto adherence
- **Accent budget.** Count visible uses of `--color-accent` per page. Hard cap: 3. The hero "writing." dot, the editorial blockquote rule, and a link underline — that's the budget. PrimaryButton resting state is `ink-0`; only its hover counts. If you see a fourth, flag it.
- **No icons / illustrations / screenshots.** If one slipped in, flag it.
- **One button style.** Any button that isn't `<PrimaryButton>` is a violation.
- **Line length.** Long-form prose should be capped via `<Measure>` (62ch default). Walls of text that flow edge-to-edge are a violation.

### 2. Token drift
- Any visible color that doesn't look like a token (e.g. an off-tone gray, a pure `#000` or `#fff` where ink-0 / paper-0 should be) → check the source for arbitrary values.
- Spacing that doesn't snap to the 8px scale — if a gap looks like 14px or 22px, it's probably an arbitrary value that should be a token.
- Font sizes that don't match the type scale — particularly easy to introduce via inline styles.

### 3. Dark-mode parity
- Buttons, badges, and bordered elements must read correctly in both themes. The PrimaryButton hover-collapse incident is the canonical example: a `bg-black` hardcode worked in light, vanished into the page in dark.
- Hairlines and dividers must remain visible — `border-paper-3` flips to a dark warm tone in dark mode; `border-ink-4` flips to a warm light tone. Pick the right one for the contrast you want.
- Accent should still feel like a signal — it shifts warmer (#E26B3A) in dark, which is intentional.

### 4. Spacing & rhythm
- Section gaps consistent across the page (controlled by `--section-gap` and the Section `gap` prop).
- Stack gaps inside sections consistent within their semantic group (eyebrow → headline → lede should always be the same triplet, regardless of section).
- No ad-hoc top/bottom margins on individual elements — that's what Stack is for.

### 5. Responsive collapse
- At 900px, multi-column layouts should collapse predictably — `<Columns count={3}>` should be 2-up; `count={2}` with `collapseAt="wide"` should still be 2-up; `count={2}` with default `collapseAt="mid"` should be single.
- At 500px, everything should be single-column. No horizontal scroll. The Header's mobile menu should be reachable.

### 6. Typography
- Headlines use `clamp()` and should scale smoothly between widths.
- Body text should be `leading-prose` (1.65) — anything tighter on long-form is a regression.
- Italic + accent dot pattern (e.g. the hero's `writing<span class="text-accent">.</span>`) should still render; check that the dot is the accent color and the period is *outside* the italic.

## Reporting format

End with a verdict:

- **Pass** — nothing flagged. Ready to mark done.
- **Pass with notes** — minor non-blocking items; list them but don't gate.
- **Divergences** — list each one with: location (file + line if known), what you saw, what the rule says, proposed fix. Don't auto-apply fixes — surface them and let the user pick.

Example divergence entry:

```
- packages/design-system/src/components/Pricing.tsx (Studio tier)
  Saw: 4th accent use on this page (top border + button hover + period dot + link).
  Rule: manifesto tenet 04, max 3 accents per page.
  Fix: drop accent top-border on Studio tier — replace with ink-4 hairline. Or move the period accent off the hero.
```

## Don't

- Don't run visual-review by eyeballing the diff. The point is the rendered output.
- Don't run it without dark mode. Dark catches half the bugs.
- Don't auto-fix divergences mid-review. Surface, let the user decide, then implement in a Mode B follow-up.
- Don't claim "matches design" without saying *which* design — link the handoff bundle, the prior screenshot, or the manifesto rule you're checking against.
