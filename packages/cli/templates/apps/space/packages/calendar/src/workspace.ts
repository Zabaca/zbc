/**
 * The company this Worker serves, from the company layer (packages/workspace): who the owner is (the people the live object tells) and the company's time zone (where an all-day event's days begin). The declaration
 * is bundled into the Worker at build time, the same file the inbox, the knowledge app and the space bundle, so they cannot disagree.
 *
 * `@calendar/declaration` is that file: the invented install's for tests and dev (tsconfig.json `paths`, which bun reads), and a company's own when the space is built for it, because the calendar store's Durable Object
 * class is built INTO THE SPACE's Worker, and the space's build says which declaration it serves (packages/space/vite.config.ts, `SPACE_DECLARATION`, which aliases this name too).
 */

import { createInstall, type Install } from '@space/workspace'
import declaration from '@calendar/declaration'

/** The install this Worker was built for. Tests pass another to the code that takes one. */
export const bundledInstall: Install = createInstall(declaration)
