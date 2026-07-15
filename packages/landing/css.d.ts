// Next 15 no longer ships an ambient declaration for side-effect CSS imports
// (`import './globals.css'` in app/layout.tsx), so a standalone
// `tsc --noEmit -p tsconfig.json` reports TS2882 for it. `next build` bundles
// the CSS regardless of this file; the declaration exists only to satisfy the
// standalone type-checker.
// See https://nextjs.org/docs/app/api-reference/config/typescript.
declare module '*.css'
