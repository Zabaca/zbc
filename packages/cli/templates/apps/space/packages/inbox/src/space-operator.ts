// The operator's three for a move of the inbox's store between Workers (the sitting is
// the space's runbook for that move): a bookmark, the counts and a restart of the store's one Durable Object.
//
// Not screens of the Inbox tab: POSTs the owner's signed-in browser makes at the sitting, each a single call to the inbox's part in the space's Worker, which admits the owner only
// (`ownerGate`). A bookmark is a read of Cloudflare's history marker; the counts are numbers under names (src/counts.ts) and nothing of a message, a draft or a person; a restart ends with the
// object reset under the call, which the part answers as done. The inbox's own restore (`prepareRestore`, `confirmRestore`, src/space-views.ts) is what goes back to a bookmark, so there is no
// restore here.

import { answered, failed, type InboxForSpace } from '@space/workspace'
import type { AsOwner, SpaceDeps } from './space-gate'

type Operator = Pick<InboxForSpace, 'storeBookmark' | 'restartStore' | 'storeCounts'>

const NO_OBJECT = 'The inbox’s store is not reachable from here. Nothing was done.'

export function createSpaceOperator(deps: Pick<SpaceDeps, 'object'>, asOwner: AsOwner): Operator {
  return {
    storeBookmark: (asker) =>
      asOwner(asker, async () => {
        const object = deps.object?.()
        if (!object) return failed(NO_OBJECT)
        return answered({ bookmark: await object.bookmark() })
      }),
    storeCounts: (asker) =>
      asOwner(asker, async () => {
        const object = deps.object?.()
        if (!object) return failed(NO_OBJECT)
        return answered({ counts: await object.counts() })
      }),
    restartStore: (asker) =>
      asOwner(asker, async () => {
        const object = deps.object?.()
        if (!object) return failed(NO_OBJECT)
        try {
          await object.restart()
        } catch {
          // The object was reset under the call, which is what was asked. Whether it restarted under the new code is read in the Worker's log
          // (`inbox: the store object started`), not here.
        }
        return answered({ restarted: true as const })
      }),
  }
}
