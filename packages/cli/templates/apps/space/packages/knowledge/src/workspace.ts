/**
 * The company this Worker serves, from the company layer (packages/workspace): who the owner is and which businesses an entry may
 * be marked for. The declaration is bundled into the Worker at build time, the same file the inbox and the space bundle and the
 * deploy reads, so the three cannot disagree about the list of businesses.
 *
 * `@knowledge/declaration` is that file: the invented install's for tests and dev (tsconfig.json `paths`, which bun reads), and a company's own when the space is built for it, because the
 * knowledge store's Durable Object class is built INTO THE SPACE's Worker, and the space's build says which declaration it serves (packages/space/vite.config.ts, `SPACE_DECLARATION`, which aliases
 * this name too). Each install therefore gets its own businesses in its own store with no change here.
 */

import { createInstall, type Install } from '@space/workspace'
import declaration from '@knowledge/declaration'

/** The install this Worker was built for. Tests pass another to the code that takes one. */
export const bundledInstall: Install = createInstall(declaration)
