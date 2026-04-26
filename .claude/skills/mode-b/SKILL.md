---
name: mode-b
description: Implementation mode for the Prose design system. One component at a time, scoped changes only, verified visually before commit. Use when modifying anything under packages/design-system/src/components/ or its tokens. Pairs with /visual-review to check rendered output.
user-invocable: true
---

Mode B is the *implementation* half of the Prose pipeline. Mode A (design authoring) happens at claude.ai/design and exports handoff bundles. Mode B is what happens here: turning a design into committed React + Tailwind code without drifting from the system's discipline.

The design system is the authority. Mode B does not invent new components, new tokens, or new exceptions to the manifesto on the user's behalf — it surfaces them as proposals first.

## Scope discipline

- **One component per session, one commit per step.** The Tailwind v4 migration shipped as 13 commits, each independently revertable. That's the cadence.
- **Don't refactor on the side.** If you spot something unrelated worth fixing, note it and move on. A bug fix doesn't need surrounding cleanup; a token rename doesn't need a comment polish.
- **Don't grow the kit.** No new components without explicit user approval. The kit is intentionally small (Header, Hero, Manifesto, Editorial, Features, Pricing, FAQ, Newsletter, Footer, PrimaryButton + 5 layout primitives). Adding a "card" or a "secondary button" is a manifesto violation.

## Authoring conventions (encoded from real failures)

- **Tailwind v4 utility classes only.** No `.prose-*` or `.editorial__*` component classes — those were deleted in Phase 13. Compose with utilities in JSX.
- **Class strings must be literal in source.** Tailwind v4's content scanner can't see `cx(\`grid-cols-${n}\`)` — it only sees what's written verbatim. Use lookup tables with full class strings as values (see `Layout.tsx` for the pattern).
- **Mobile-first breakpoints.** Three only: `narrow:` (480px), `mid:` (720px), `wide:` (960px). Tailwind's defaults (`sm:` etc.) are nuked in tokens.css. Don't reintroduce them.
- **`clamp()` font sizes stay inline.** `style={{ fontSize: 'clamp(...)' }}` — Tailwind doesn't compose with clamp cleanly, and these are semi-arbitrary values that read more clearly raw.
- **Tokens are the source of truth for color/space/type.** If a value isn't in `tokens.css`, propose adding it before reaching for `text-[#abcdef]` or `p-[19px]`. Arbitrary values are an escape hatch, not a default.
- **Bun, not npm.** `bun install`, `bun run dev`. The dev script needs the `--bun` flag (Node 18.5 compatibility issue with Astro/Vite).

## Manifesto rules (the design discipline)

These are user-facing rules from `packages/design-system/src/components/Manifesto.tsx`. Mode B is responsible for not silently violating them.

1. Write the page first.
2. Cut a third of it.
3. Set the longest line in 78 characters or fewer (use `<Measure size="wide">`).
4. **One accent color, used three times max per page.** Audit on every change — the accent appears in link underlines, blockquote rules, pricing top borders, the hero "writing." dot, and PrimaryButton hover. Adding a fourth use is a violation.
5. Leave more space than feels comfortable.

Plus the unwritten ones: no icons, no illustrations, no screenshots, one button style (PrimaryButton).

## Protocol

For each change:

1. **State the scope** in one sentence before touching anything. "Migrate Newsletter component to utility classes." "Fix dark-mode hover on PrimaryButton." If you can't say it in one sentence, the scope is wrong.
2. **Read the existing component** and the tokens it uses. Don't assume.
3. **Implement.** Edit the JSX, delete any matching CSS rules in the same change.
4. **Visual-verify with the screenshot skill.** At minimum: 1280px light + dark for the route the change touches. For layout/responsive changes: add 900px and 500px.
5. **Commit.** Lefthook runs oxlint + oxfmt automatically. Title: `<scope>: <verb> <object>` (e.g. `PrimaryButton: theme-aware hover via accent`). Body explains the *why* if non-obvious.
6. **Mark the task done** if there's an active TaskList; pick up the next one.

If anything in step 1–4 feels off (scope drift, missing token, manifesto violation, broken render) — stop and surface it. Don't paper over.

## Don't

- Don't ship a "small adjacent fix" inside a Mode B commit. New commit, or new session.
- Don't claim visual fidelity without screenshots. "Should look right" is not verification.
- Don't add backwards-compat shims (`// removed`, `_unused`, re-exports). The migration is done; legacy is gone.
- Don't write component-level CSS classes. JSX + utilities only.
- Don't author docs/comments explaining what the code does. Names do that. Comments are for non-obvious *why*.

## Where the authority lives

- **Tokens** — `packages/design-system/src/tokens.css`
- **Element defaults + custom utilities** — `packages/design-system/src/index.css`
- **Layout primitives** — `packages/design-system/src/components/Layout.tsx`
- **Manifesto rules** — `packages/design-system/src/components/Manifesto.tsx` (user-facing copy IS the rule)
- **Repo conventions** — `CLAUDE.md` (root) and `packages/design-system/CLAUDE.md` if it exists
- **Screenshots / verification** — `.claude/skills/screenshot/SKILL.md`

## Exit

A Mode B session ends when the stated scope from step 1 is implemented, verified visually, and committed. Open scope creep into a separate session.
