# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it names the contexts and points at each one's glossary. Read it first to work out which context you're in.
- **The `CONTEXT.md` for that context**, not every one of them.
- **`docs/adr/`** for that context, plus the root `docs/adr/` — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

This repo is multi-context:

```
/
├── CONTEXT-MAP.md                 ← start here
├── CONTEXT.md                     ← Infrastructure (spans cli + infra)
├── docs/adr/                      ← repository-wide decisions
│   ├── 0001-....md
│   └── 0002-....md
└── packages/
    └── agent/
        ├── CONTEXT.md             ← Agent
        └── docs/adr/              ← agent-context decisions
```

Terms are **not** shared across contexts, and some collide deliberately — check the map's Relationships section before assuming a word means what it means elsewhere.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
