// The space's five busiest reads of the inbox, run INSIDE the store's object: one call from the Worker each, where each was a chain of calls.
//
// The inbox's part of the space (src/space.ts `createSpaceInbox`) reaches the store through `store.call`, one call per step: who the person may see (`mailScope`), then the conversations, then the
// Clients' suggestions, and so on. From the space's Worker each of those is a round trip to the object, measured on a live install at 60 to 120 ms even when the object did no work (the Worker
// answers near the person, the object lives where it was made), so a list was four trips in a row and opening a conversation about ten. Here the same part is built inside the object over the
// store itself (`store.call` is the object's own `call`, in-process), and the Worker asks the object for the whole read once (`read*` below, through src/space-part.ts). The rules are the part's,
// unchanged: this file only says which reads go across and in what shape.
//
// TRUST: a read here is handed the `SignedIn` the space's one sign-in check made, exactly as the part in the Worker is; the object is reachable only from its own Worker's code, which makes that
// check before it asks (the company layer's ADR 0003). Writes stay in the Worker's part: they are one or two calls, and their results carry what a page shows next.

import type { InboxForSpace } from '@space/workspace'

/** The reads the Worker hands to the object whole, by the name `call` knows them by. */
export const SPACE_READ_METHODS = [
  'readPeople',
  'readNavigation',
  'readMessagesWith',
  'readDrafts',
  'readSearch',
] as const
export type SpaceReadMethod = (typeof SPACE_READ_METHODS)[number]

/** The five reads, over a part made on first use (the object's own store, install and Clients). */
export class SpaceReads {
  private made: InboxForSpace | undefined

  constructor(private readonly make: () => InboxForSpace) {}

  private get part(): InboxForSpace {
    this.made ??= this.make()
    return this.made
  }

  readPeople(...args: Parameters<InboxForSpace['people']>): ReturnType<InboxForSpace['people']> {
    return this.part.people(...args)
  }

  readNavigation(...args: Parameters<InboxForSpace['navigation']>): ReturnType<InboxForSpace['navigation']> {
    return this.part.navigation(...args)
  }

  readMessagesWith(...args: Parameters<InboxForSpace['messagesWith']>): ReturnType<InboxForSpace['messagesWith']> {
    return this.part.messagesWith(...args)
  }

  readDrafts(...args: Parameters<InboxForSpace['drafts']>): ReturnType<InboxForSpace['drafts']> {
    return this.part.drafts(...args)
  }

  readSearch(...args: Parameters<InboxForSpace['search']>): ReturnType<InboxForSpace['search']> {
    return this.part.search(...args)
  }
}
