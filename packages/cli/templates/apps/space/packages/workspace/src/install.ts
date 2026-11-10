// One install, read: what the space asks the company layer.
//
// An Install is a parsed declaration with the questions the front door and the apps it runs ask of it. It holds no
// state and does no I/O, so each Worker builds it once at start from the declaration its deploy bundled.

import { type Business, type ClientFieldKind, type CloudflareMailboxDeclaration, type Company, type Declaration, type FormsServiceDeclaration, type GoogleAppDeclaration, type HostedMailboxDeclaration, type PhoneDeclaration, parseDeclaration, type PlaceName, type Person, SPACE, SWITCHES, type Switch } from './declaration'

/**
 * The space's seven tabs that an install may have, in the order they are drawn (Knowledge comes after People, packages/space/docs/adr/0008; Inbox and Meet
 * stand in the place of one combined Conversations tab, because chat, channels, calls and the phone belong in a Meet top level of their own, packages/space/docs/adr/0014;
 * Calendar comes after Meet, packages/space/docs/adr/0020). An install has the tabs its switches give it, in this order (`Install.tabs`): Calendar only where `gmail` is on, and Inbox only where the install has a mailbox of any kind. The company layer's ADR 0004 records the change from
 * "the same seven in every install". `path` is where the tab lives on the space's address. `ownSignIn` marks the tab that has an Access application of its own, with a shorter sign-in
 * than the space's (Forms: a day, where the space is a month; packages/space/docs/adr/0002).
 */
export const TABS = [
  { id: 'today', label: 'Today', path: '/today', ownSignIn: false },
  { id: 'inbox', label: 'Inbox', path: '/inbox', ownSignIn: false },
  { id: 'meet', label: 'Meet', path: '/meet', ownSignIn: false },
  { id: 'calendar', label: 'Calendar', path: '/calendar', ownSignIn: false },
  { id: 'forms', label: 'Forms', path: '/forms', ownSignIn: true },
  { id: 'people', label: 'People', path: '/people', ownSignIn: false },
  { id: 'knowledge', label: 'Knowledge', path: '/knowledge', ownSignIn: false },
] as const
export type TabId = (typeof TABS)[number]['id']

/** The tab the space opens on: what needs you comes first. */
export const HOME_TAB: TabId = 'today'

export interface Tab {
  id: TabId
  /** What the tab says: "Today", "Inbox", "Meet", "Calendar", "Forms", "People", "Knowledge". */
  label: string
  /** Where it lives on the space's address: "/today". */
  path: string
  /** The whole address: "https://space.northfield.example/today". */
  url: string
  /** True for the tab the page is on. */
  current: boolean
  /** True for the tab Access asks a sign-in of its own for (Forms). */
  ownSignIn: boolean
}

/** What the deploy gives Cloudflare Access for one place (the space or Forms): the module's `access` block, minus the secrets. */
export interface AccessApplication {
  /** A host, plus the path Access protects when it is not the whole host. */
  domain: string
  /** Every person's sign-in address: one list for both applications, since there is one sign-in. */
  allowedEmails: string[]
  sessionDuration: string
}

/**
 * The one path of the space where a machine is let in: Claude's script, with the service token the inbox names, on the way to the inbox
 * (packages/workspace/docs/adr/0002). An Access application of its own sits on exactly `domain`, admitting that token and no person.
 */
export interface AgentDoor {
  /** The path on the space's host: "/agent/inbox". */
  path: string
  /** The host and path Access protects: "space.northfield.example/agent/inbox". */
  domain: string
  /** The whole address Claude's script is pointed at: "https://space.northfield.example/agent/inbox". */
  url: string
}

/** The Clients door: an `AgentDoor` of its own, and the name of the source the Clients that arrive through it are from. */
export interface ClientsDoor extends AgentDoor {
  source: string
  /** The key of the source's extra field that holds an address to suggest a Client by, or null where the source has none (the declaration's `suggestByAddressKey`). */
  suggestByAddressKey: string | null
  /** How the source's extra fields are drawn, in the order the declaration lists them (the declaration's `fields`); empty where it lists none. */
  fields: ClientFieldDisplay[]
}

/** One declared extra field of a source, as it is drawn: its key, label, kind and whether the Client's row in the list shows it. */
export interface ClientFieldDisplay {
  key: string
  label: string
  kind: ClientFieldKind
  list: boolean
}

/** The name a person's outgoing mail carries: the declared `mailName`, else their name. */
export const mailNameOf = (person: Person): string => person.mailName ?? person.name

/** The Google app of an install with the Gmail switch on: its client id and the topic Gmail's watch publishes to. */
export type GoogleApp = GoogleAppDeclaration

/** A mailbox on an install's own mail server (JMAP), as declared. */
export type HostedMailbox = HostedMailboxDeclaration

/** A business mailbox fed by Cloudflare Email Routing, as declared. */
export type CloudflareMailbox = CloudflareMailboxDeclaration

export interface Install {
  readonly declaration: Declaration
  readonly company: Company
  readonly teamDomain: string
  readonly people: readonly Person[]
  /** Whether a switch is on. A switch is on only where the declaration gave the settings it needs (`parseDeclaration` refuses it otherwise), and every part of the space reads it here. */
  has(sw: Switch): boolean
  /** Every switch and whether it is on: what the page is told, so it draws only what the install has. */
  switches(): Record<Switch, boolean>
  /** The person Access's sign-in address names, or null for anyone else (including no one). */
  personBySignIn(signIn: string | null | undefined): Person | null
  /** The person a company address names, or null. */
  person(address: string): Person | null
  isOwner(person: Person): boolean
  /**
   * The install's owner: the first owner the declaration lists (an install has at least one). The one person the inbox's owner-only acts are (connecting Gmail, Claude's switch, restore), whose name the refusals and labels say, whom the mail to "the owner"
   * goes to, and whose Claude's script is. Every other person of the install, an owner or not, is let into the inbox once they are on a mailbox (`mailboxPeople`), and sees only theirs.
   */
  owner(): Person
  /** The shared addresses a person works: every one for an owner, their own list for a member. */
  sharedAddressesOf(person: Person): string[]
  /** The company's businesses: what a mailbox drafts for and a knowledge entry is marked for. At least one. */
  businesses(): Business[]
  /** The business a mailbox address drafts for (trimmed and lowercased), or null for an address in none. */
  businessOf(mailbox: string | null | undefined): Business | null
  /** The space's front page, "https://space.northfield.example/": the address every link the apps send is made from, guests' and signers' included. */
  url(): string
  /** The install's tabs in the order they are drawn (`TABS`, less the ones whose part is off), `current` marked (none when it is not one of them). */
  tabs(current?: TabId): Tab[]
  /**
   * The Access application the deploy makes for one place. The space's covers its whole host; Forms' is on the Forms tab's path of the space's host, with its own
   * (shorter) sign-in length.
   */
  accessApplication(place: PlaceName): AccessApplication
  /**
   * Claude's door on the space, or null while the declaration gives no `agent`. A path the space answers before its person check, behind
   * an Access application that admits one service token and no person.
   */
  agentDoor(): AgentDoor | null
  /**
   * The Telegram bridge's door on the space, or null while the declaration gives no `telegram`: a path of its own, answered before the person check, behind an Access application of its own
   * that admits one service token ("telegram bridge") and no person. The same shape as Claude's (`AgentDoor`), and never the same path or token.
   */
  telegramDoor(): AgentDoor | null
  /**
   * The Clients door on the space, or null while the declaration gives no `clientsDoor`: a third machine path, answered before the person check, behind an Access application of its own that admits one service token
   * (an outside system pushing its Clients in) and no person, plus the name of the source those Clients are from. Never the same path or token as Claude's or the bridge's.
   */
  clientsDoor(): ClientsDoor | null
  /**
   * The address an app's mail goes out from: Forms' signing mail or Meet's invitations and notices. On the company's own domain, declared (`senders`) or the company's `forms@` and `meet@`; the Worker's send
   * binding allows exactly these two.
   */
  sender(app: 'forms' | 'meet'): string
  /** The signing service's words (the declaration's `formsService`): what it is called, the address a person writes to about it, and who runs it. A copy. */
  formsService(): FormsServiceDeclaration
  /** The machine host Gmail's push is delivered to ("inbox-push.northfield.example"), or null where the Gmail switch is off. */
  gmailPushHost(): string | null
  /** The install's own Google app (client id and push topic), or null where the Gmail switch is off. */
  googleApp(): GoogleApp | null
  /** The mailboxes on the install's own mail server, a copy; none where the `hostedMailboxes` switch is off. */
  hostedMailboxes(): HostedMailbox[]
  /** The business mailboxes fed by Cloudflare Email Routing, a copy; none where the declaration lists none. */
  cloudflareMailboxes(): CloudflareMailbox[]
  /** The Cloudflare mailbox with this address (trimmed and lowercased), or null. */
  cloudflareMailbox(address: string | null | undefined): CloudflareMailbox | null
  /**
   * Who is on a declared business mailbox (Cloudflare's or the mail server's, by address, trimmed and lowercased): the work addresses its declaration lists, else the owner alone. Null for an address that is
   * none of the declared ones (a Gmail account is its connector's and the Telegram mailbox the owner's: neither is declared). A copy.
   */
  mailboxPeople(address: string | null | undefined): string[] | null
  /** Who has the dial pad and the number each one's 911 calls leave from, by work address, a copy; empty where the `phone` switch is off. */
  phonePeople(): PhoneDeclaration['people']
  /** Whether the install has a mailbox of any kind: Gmail, a mailbox on its mail server, Telegram, or a business mailbox it declares. The Inbox tab is there only then. */
  hasMailbox(): boolean
  /** Whether the install has this tab (`tabs` lists exactly these). */
  hasTab(tab: TabId): boolean
  /** The path a tab lives at on the space's address: "/forms". */
  tabPath(tab: TabId): string
}

/** A declared mailbox copied, its list of people too, so nothing a caller changes reaches the declaration. */
const copyMailbox = <T extends { people?: string[] }>(m: T): T => ({ ...m, ...(m.people !== undefined && { people: [...m.people] }) })

/** An install from a declaration's JSON, refused with every problem named if it is not whole. */
export function createInstall(input: unknown): Install {
  const declaration = parseDeclaration(input)
  const { company, people, space, forms, switches } = declaration
  const bySignIn = new Map(people.map((p) => [p.signIn, p]))
  const byAddress = new Map(people.map((p) => [p.address, p]))
  const tabPath = (tab: TabId) => TABS.find((t) => t.id === tab)!.path
  const hasMailbox = switches.gmail || switches.hostedMailboxes || switches.telegram || declaration.businesses.some((b) => b.mailboxes.length > 0)
  // The tabs whose part can be off: Calendar needs a Google account (the Gmail switch), Inbox needs a mailbox of any kind. Every other tab is every install's.
  const hasTab = (tab: TabId): boolean => (tab === 'calendar' ? switches.gmail : tab === 'inbox' ? hasMailbox : true)

  // parseDeclaration refuses a declaration with no owner.
  const firstOwner = people.find((p) => p.role === 'owner') as Person
  const businesses = declaration.businesses
  const byMailbox = new Map(businesses.flatMap((b) => b.mailboxes.map((m) => [m, b] as const)))
  const copy = (b: Business): Business => ({ ...b, mailboxes: [...b.mailboxes] })

  return {
    declaration,
    company,
    teamDomain: declaration.access.teamDomain,
    people,
    has: (sw) => switches[sw],
    switches: () => Object.fromEntries(SWITCHES.map((s) => [s, switches[s]])) as Record<Switch, boolean>,
    personBySignIn: (signIn) => (typeof signIn === 'string' ? (bySignIn.get(signIn.trim().toLowerCase()) ?? null) : null),
    person: (address) => byAddress.get(address.trim().toLowerCase()) ?? null,
    isOwner: (person) => person.role === 'owner',
    owner: () => firstOwner,
    sharedAddressesOf: (person) => (person.role === 'owner' ? [...declaration.sharedAddresses] : [...person.sharedAddresses]),
    businesses: () => businesses.map(copy),
    businessOf: (mailbox) => {
      const b = typeof mailbox === 'string' ? byMailbox.get(mailbox.trim().toLowerCase()) : undefined
      return b ? copy(b) : null
    },
    url: () => `https://${space.host}/`,
    tabPath,
    sender: (app) => declaration.senders[app],
    formsService: () => ({ ...declaration.formsService, runBy: { ...declaration.formsService.runBy } }),
    gmailPushHost: () => declaration.gmailPush?.host ?? null,
    googleApp: () => (declaration.googleApp ? { ...declaration.googleApp } : null),
    hostedMailboxes: () => (declaration.hostedMailboxes ?? []).map(copyMailbox),
    cloudflareMailboxes: () => (declaration.cloudflareMailboxes ?? []).map(copyMailbox),
    cloudflareMailbox: (address) => {
      const found = typeof address === 'string' ? (declaration.cloudflareMailboxes ?? []).find((m) => m.address === address.trim().toLowerCase()) : undefined
      return found ? copyMailbox(found) : null
    },
    mailboxPeople: (address) => {
      const wanted = typeof address === 'string' ? address.trim().toLowerCase() : ''
      const found = [...(declaration.cloudflareMailboxes ?? []), ...(declaration.hostedMailboxes ?? [])].find((m) => m.address === wanted)
      return found ? [...(found.people ?? [firstOwner.address])] : null
    },
    phonePeople: () => Object.fromEntries(Object.entries(declaration.phone?.people ?? {}).map(([who, v]) => [who, { ...v }])),
    hasMailbox: () => hasMailbox,
    hasTab,
    agentDoor: () => {
      const agent = declaration.agent
      if (agent === undefined) return null
      return { path: agent.path, domain: `${space.host}${agent.path}`, url: `https://${space.host}${agent.path}` }
    },
    telegramDoor: () => {
      const telegram = declaration.telegram
      if (telegram === undefined) return null
      return { path: telegram.path, domain: `${space.host}${telegram.path}`, url: `https://${space.host}${telegram.path}` }
    },
    clientsDoor: () => {
      const door = declaration.clientsDoor
      if (door === undefined) return null
      return {
        path: door.path,
        domain: `${space.host}${door.path}`,
        url: `https://${space.host}${door.path}`,
        source: door.source,
        suggestByAddressKey: door.suggestByAddressKey ?? null,
        fields: Object.entries(door.fields ?? {}).map(([key, f]) => ({ key, label: f.label, kind: f.kind ?? 'text', list: f.list ?? false })),
      }
    },
    tabs: (current) =>
      TABS.filter((t) => hasTab(t.id)).map((t) => ({ id: t.id, label: t.label, path: t.path, url: `https://${space.host}${t.path}`, current: t.id === current, ownSignIn: t.ownSignIn })),
    accessApplication: (p) => ({
      domain: p === SPACE ? space.host : `${space.host}${tabPath('forms')}`,
      allowedEmails: people.map((q) => q.signIn),
      sessionDuration: p === SPACE ? space.sessionDuration : forms.sessionDuration,
    }),
  }
}
