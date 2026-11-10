// What the page is told about who is asking and where things are: the answer of GET /api/me. Types only, shared by the
// Worker that builds it (app.ts) and the page that reads it (client/), so the two cannot drift.

import type { Switch, TabId } from '@space/workspace'

export interface TabView {
  id: TabId
  label: string
  /** Where it lives on the space's address: "/today". */
  path: string
  /**
   * True where an app's screens are in the tab and Access asks for a sign-in of their own there (Forms: a day, where the space is a
   * month). Absent otherwise. The page opens such a tab with a full page load, because only a load of the page itself can be sent to
   * Access's sign-in: a day's session is renewed before a screen is drawn, not found gone on its first call (src/client/forms/session.ts).
   */
  ownSignIn?: true
}

export interface Me {
  /** The address that names the person (their work address), and what they are called. */
  address: string
  name: string
  /** The company's name and the time zone its day and its meetings are read in (`company.timeZone` of the declaration). */
  company: { name: string; timeZone: string }
  /** The install's owner (the first owner its declaration lists): where a screen names who can do something, who Claude acts for, or what address Claude sends from. */
  owner: { name: string; address: string }
  /** The install's tabs, in the order they are drawn, from the company layer: only the ones whose part the install has (no Calendar without a Google account, no Inbox without a mailbox of any kind). */
  tabs: TabView[]
  /** Every switch of the install and whether it is on. The page draws a part only where its switch is: no call button where `calls` is off, no phone, no Gmail connection or Calendars section where `gmail` is off. */
  switches: Record<Switch, boolean>
  /** The tab the space opens on. */
  home: TabId
  /**
   * The space's own address ("https://space.northfield.example/"), which every link the apps make is on: a call link is `<origin>r/<name>`, a path that needs no sign-in (the guest paths,
   * packages/space/docs/adr/0018). The page makes and recognises call links from it.
   */
  origin: string
  /** The addresses the install's mail goes out from (the declaration's `senders`): what an invitation to a channel and a signing email say they come from. */
  senders: { forms: string; meet: string }
  /** The signing service Forms runs, in the install's words: what it is called ("Northfield Forms"), the address its mail comes from and who runs it ("Northfield Works"); `ownCompanyOnly` (present only when true) where Forms sends only for the company itself, and the previews then show no "via <service>". */
  forms: { service: string; sender: string; runBy: string; ownCompanyOnly?: true }
}
