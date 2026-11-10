// What one install declares about its company, and the check that a declaration is whole.
//
// A declaration is plain JSON so that the deploy (the install kit, for Access's allow list), the Workers (for the
// sign-in check) and the tests all read the same file and cannot disagree. It is JSON and not a .ts file because
// zbc loads every *.ts file in an environment's folder and demands a module instance from it
// (zbc's src/engine/discover.ts); a .json file in that folder is not looked at.
//
// Zero dependencies and no I/O, so a Worker can bundle it. parseDeclaration reports every problem at once, since a
// declaration is edited by hand and the fix is a list.

import { CLIENT_EXTRA_KEY } from './clients'

/** The two places the deploy makes an Access application for: the space's whole host, and Forms' day-long sign-in on its tab's path of it. */
export const SPACE = 'space'
export type PlaceName = typeof SPACE | 'forms'

/**
 * The space's tab ids, as `TABS` in install.ts names them (install.test.ts pins that the two agree). The declaration needs them to keep the
 * agent's path off the space's own; this file cannot import `TABS` (install.ts imports this one), so the ids are written here too.
 */
export const TAB_IDS = ['today', 'inbox', 'meet', 'calendar', 'forms', 'people', 'knowledge'] as const

export const ROLES = ['owner', 'member'] as const
export type Role = (typeof ROLES)[number]

/**
 * The switches of an install. Every one defaults to off, so a company that says nothing gets the smallest workspace. No switch is anyone's alone: any install may turn any of them on, and a switch is
 * ALLOWED exactly where the declaration gives the settings it needs and REFUSED without them (see "What each switch needs" in `parseDeclaration`): a Gmail switch with no Google app and push host of its own is
 * a declaration that does not parse, so a half-set-up feature fails at deploy and is never found broken later. `calls` and `manyClients` need nothing from the declaration.
 * Every part of the space reads its switch (`Install.has`), and a tab whose part is off is not drawn (`Install.tabs`).
 */
export const SWITCHES = [
  'gmail',
  'hostedMailboxes',
  'clientDirectory',
  'claudeScript',
  'assistant',
  'phone',
  'manyClients',
  'calls',
  'telegram',
] as const
export type Switch = (typeof SWITCHES)[number]

/** What an install gets for a switch it does not name: off. */
export const SWITCH_DEFAULTS: Readonly<Record<Switch, boolean>> = {
  gmail: false,
  hostedMailboxes: false,
  clientDirectory: false,
  claudeScript: false,
  assistant: false,
  phone: false,
  manyClients: false,
  calls: false,
  telegram: false,
}

export interface Company {
  /** A slug, stable for the life of the install. */
  id: string
  name: string
  /**
   * The name the law knows the company by ("Northfield Works LLC"), which a legal record names it as: the certificate in a signed document says Claude acted for it. The name where left out. Not the signing service's runner's
   * (`formsService.runBy`), which another company may be while Claude's principal stays the install's own company.
   */
  legalName?: string
  /** The company's own domain, bare: "northfield.example". */
  domain: string
  /** An IANA time zone. */
  timeZone: string
  /** A path or URL the apps show beside the name; absent means the name alone. */
  logo?: string
  /** Hex colors; absent means each app's own look. */
  colors?: { accent?: string }
}

export interface Person {
  /**
   * The address that names the person and is recorded as the actor. Lowercase. Usually on the company's domain; a
   * company whose people use personal Gmail names them by that address instead.
   */
  address: string
  name: string
  /** The address Cloudflare Access sends the sign-in code to. Lowercase; the work address unless declared otherwise. */
  signIn: string
  /**
   * The name the person's outgoing mail carries in its From line ("Tessa Marlow" in `Tessa Marlow <tessa@northfield.example>`), where it differs from `name`, the short name the space says them by
   * ("Tessa"). Left out: the mail carries `name` (`mailNameOf`, install.ts).
   */
  mailName?: string
  role: Role
  /** Shared addresses the person is on. An owner is on every shared address whatever this says. */
  sharedAddresses: string[]
}

/**
 * The space: the one address the company's team signs in at and works in, and the one Worker that runs every app (the space's ADR 0001). The whole host is behind Access except three paths guests and signers use (`GUEST_PREFIXES` of the
 * space, which are the layer's and not declared). So there is no `door` to declare.
 */
export interface SpaceDeclaration {
  /** "space.northfield.example"; a client's is "space.<its domain>". */
  host: string
  /** How long a sign-in lasts: a month. Forms asks again once a day (`FormsDeclaration`). */
  sessionDuration: string
}

/**
 * Forms' sign-in: an Access application of its own on the Forms tab's path of the space's host (`space.northfield.example/forms`), because forms holds the answers people
 * give to a document and so asks again sooner than the space does (packages/space/docs/adr/0002). Left out of a declaration, a day.
 */
export interface FormsDeclaration {
  /** How long a sign-in lasts, in Cloudflare's duration format ("24h"). */
  sessionDuration: string
}

/**
 * The machine address Google's Pub/Sub delivers Gmail's push to (inbox-push.northfield.example): a second Custom Domain of the space's Worker with no Access application,
 * answering one path to a Google-signed token and nothing else (packages/space/docs/adr/0017). Present exactly where the `gmail` switch is on, with `googleApp`.
 */
export interface GmailPushDeclaration {
  host: string
}

/**
 * The install's own Google app, which the Gmail switch needs beside the push host: the OAuth web client's id (public: it is in the sign-in address Connect Gmail sends the browser to; its secret is a Worker
 * secret and never here) and the Pub/Sub topic Gmail's watch publishes to ("projects/<project>/topics/<topic>"). Northfield's are the app "Inbox northfield" and its topic. Present exactly where the `gmail` switch is on.
 */
export interface GoogleAppDeclaration {
  clientId: string
  pushTopic: string
}

/**
 * One mailbox on the install's own mail server, read and written over JMAP: what the `hostedMailboxes` switch needs (at least one). Four things and nothing secret, as the inbox's parser of the same list holds them
 * (packages/inbox/src/jmap/declared.ts, which keeps the rest of the rules: the owner's Gmail is not declared here, and two mailboxes need two names).
 */
export interface HostedMailboxDeclaration {
  /** The mailbox's address, lowercase and bare: the one its sends come from. */
  address: string
  /** What its conversations are marked with (the pill). */
  name: string
  /** The address of the server's JMAP door: https, a hostname and nothing after it. */
  door: string
  /** The NAME of the Worker secret that holds the mailbox's key (never the key), upper case. */
  secret: string
  /** Who is on the mailbox: the work addresses of people of this install (`people`), the ones who see its mail and send from it. Left out, the install's owner alone. See `MailboxPeople`. */
  people?: string[]
}

/**
 * One mailbox of a business, fed by Cloudflare Email Routing (the inbox keeps its mail, and a reply goes out as its own address through the Worker's send binding): a business's own addresses beside the owner's Gmail. Where the mailbox is declared (the Worker's `INBOX_MAILBOXES` var, which the inbox reads, is written from this list by the install kit, kit/worker-settings.ts), what it is called, and whether its spam check
 * runs on it to begin with. Its assistant's persona and its spam check's questions are not here: they are content files beside the declaration (`workspace-content.json`, read by the inbox, `packages/inbox/src/mailbox-content.ts`),
 * and a mailbox with none gets no assistant and no spam check. The mailbox is one of a business's (`businesses`), so it is the address that business's knowledge is asked for.
 */
export interface CloudflareMailboxDeclaration {
  /** The mailbox's address, lowercase and bare: one per domain, because Email Routing's catch-all hands over the whole domain's mail. */
  address: string
  /** What its conversations are marked with (the pill): the business's name. */
  name: string
  /** What a sentence calls it when it names the install's mailboxes ("Brightwater", for "Brightwater’s"). The name where left out. */
  short?: string
  /** Whether the spam check runs on it until the owner switches it; absent is off. It runs only where the mailbox has spam questions in the install's content. */
  spamCheck?: boolean
  /** Who is on the mailbox: the work addresses of people of this install (`people`), the ones who see its mail and send from it, so a shared mailbox lists everyone it is shared with. Left out, the install's owner alone. See `MailboxPeople`. */
  people?: string[]
}

/**
 * WHO IS ON A MAILBOX. Every mailbox of an install has people: one person (a Gmail account they connected, which only they see) or a list (a shared mailbox).
 * The inbox shows a person only the mailboxes they are on, and a person sends only from those. For the install's declared business mailboxes (Cloudflare's and the mail server's) the list is a field of the declaration, `people`, naming people of
 * this install by their work address; left out, the mailbox is the install's owner's alone, which is the default for every business mailbox. A Gmail account is its connector's, and the Telegram mailbox the owner's: neither is declared.
 * This declaration is where the people come from until people are kept by the space; the inbox's store holds the lists it reads from (migration 19 of its store), so the source can change without the reads changing.
 */
export type MailboxPeople = string[]

/**
 * What the `phone` switch needs: who has the dial pad and the number their 911 calls leave from, by the person's work address. `line` is the install's own number, which holds one registered address, so ONE
 * person at most may use it; another person needs a number of their own, in E.164 (Telnyx has no per-call address for a browser call: packages/meet/docs/adr/0004, section 5). Not on this list means no dial pad,
 * whoever they are. The line's number and Telnyx's keys are Worker secrets and never here.
 */
export interface PhoneDeclaration {
  people: Record<string, { emergencyNumber: 'line' | string }>
}

/**
 * Claude's door on the space: the one path where the inbox admits Claude's service token and nobody else (packages/workspace/docs/adr/0002). An Access application
 * of its own sits on exactly the space's host and this path, admitting that token and no person, and the space answers the path before its person check. Only
 * where the `claudeScript` switch is on.
 */
export interface AgentDeclaration {
  /** The path of the space's host: "/agent/inbox", with no trailing slash and not one of the space's own (its API or a tab). The name of the service token the application admits is the install file's (the install kit), never the declaration's. */
  path: string
}

/**
 * The Telegram bridge's door on the space: a second machine path, shaped like Claude's (`AgentDeclaration`) and held apart from it. Its own Access application sits on exactly the space's
 * host and this path ("/agent/telegram"), admitting one service token of its own ("telegram bridge") and no person, and the space answers the path before its person check.
 * Present exactly where the `telegram` switch is on, which any install may turn on with its own bridge (packages/workspace/docs/adr/0002, amended by ADR 0004).
 */
export type TelegramDeclaration = AgentDeclaration

/**
 * The Clients door on the space (the space's ADR 0021): the one path where an outside system that keeps Clients of its own, such as the company's website, PUSHES them in, with a
 * service token of its own and no person. The same shape as Claude's door and the bridge's, held apart from both, plus `source`: what the Clients that arrive there are called wherever a Client says where it came from
 * ("northfield.example"). Present exactly where the `clientDirectory` switch is on, which any install with an outside system of its own may turn on; an install with none declares neither and makes its Clients in its own space.
 */
export interface ClientsDoorDeclaration extends AgentDeclaration {
  /** One line of at most `CLIENT_SOURCE_NAME_MAX` characters. A Client the door brings in carries it; the part refuses a push in any other name. */
  source: string
  /**
   * The key of the source's extra field that holds an address the Client's people write from (for a website's Clients, the address a Client signs in to its portal with). The inbox suggests a Client for a
   * contact whose address equals it. Left out: the source has no such field, and suggestions go by domain alone. The space reads no other key of a source's extra fields.
   */
  suggestByAddressKey?: string
  /**
   * How the source's extra fields are drawn, by key: a label, a kind (text, or a time the sender writes as an ISO moment) and whether the Client's row in the list shows it too. A key not listed is
   * shown on the Client's page under its key made readable, as text. The space attaches no meaning to any key; this is only how it is drawn.
   */
  fields?: Record<string, ClientFieldDeclaration>
}

/** How one of a source's extra fields is drawn (see `ClientsDoorDeclaration.fields`). */
export interface ClientFieldDeclaration {
  /** One line of at most `CLIENT_FIELD_LABEL_MAX` characters. */
  label: string
  /** Text by default. */
  kind?: ClientFieldKind
  /** Also shown on the Client's row in the list. */
  list?: boolean
}

/** `text` is shown as it came; `time` is an ISO moment shown as a date. */
export type ClientFieldKind = 'text' | 'time'
export const CLIENT_FIELD_KINDS: readonly ClientFieldKind[] = ['text', 'time']

/** The longest label a declared field may have. */
export const CLIENT_FIELD_LABEL_MAX = 60

/** The longest mail name a person may have. */
export const MAIL_NAME_MAX = 80

/** The longest name of a service, of who runs it, or a mailing line. */
export const SERVICE_NAME_MAX = 80

/** The longest name a source of Clients may have. */
export const CLIENT_SOURCE_NAME_MAX = 40

/**
 * One business of the company: what a mailbox drafts for and what a knowledge entry is marked for (knowledge is kept per business).
 * A company may run several (Northfield Works runs two brands); the id and the name outlive any
 * address.
 */
export interface Business {
  /** A slug, stable: what a stored entry names. */
  id: string
  name: string
  /** The mailbox addresses that draft for this business, lowercase. None is allowed: a business need not have a mailbox. */
  mailboxes: string[]
}

/**
 * The addresses the install's mail goes out from, each on the company's own domain (the Worker's send binding allows exactly these): Forms' signing mail and Meet's invitations and notices. Left out, `forms@<domain>`
 * and `meet@<domain>`. Northfield's are forms@northfield.example and meet@northfield.example.
 */
export interface SendersDeclaration {
  forms: string
  meet: string
}

/** Who runs the signing service, as a signer is told it: the short name ("Northfield Works"), the legal name ("Northfield Works LLC") and the mailing line the email footer carries ("Springfield, Ohio", or none). */
export interface ServiceRunnerDeclaration {
  name: string
  legalName: string
  mailingLine: string
  /** Its own domain, bare ("northfield.example"): where a signer's page links to who runs the service. The company's domain unless declared (a company whose Forms is run by another says the runner's). */
  site: string
}

/**
 * The signing service Forms runs, in the words a signer, an email and a seal carry: what it is called ("Northfield Forms", which "via" follows a business's name in a signer's mail and which the seal's subject begins with),
 * the address a person writes to about it and their information (it need not be on the company's domain), and who runs it. The contact is required (it is published, on the signer's page and the privacy notice, so it is never taken from a person's own address); left out, the service is "<company> Forms" and the company runs it.
 * Forms' consent and terms keep their sentences; only these names are the install's, so no legal wording is written here, with one exception: `ownCompanyOnly` below switches the sentences that name a second party to
 * their own-company wording, which Forms owns.
 */
export interface FormsServiceDeclaration {
  name: string
  contact: string
  runBy: ServiceRunnerDeclaration
  /**
   * Present, and true, only where this install's Forms sends only for its own company (Brightwater's space runs Forms for Brightwater Builders alone). A signer is then told there is no second party: no "via <service>"
   * under the business's name, no "the service, not a party" and no "for the businesses it builds websites for". Left out (false) by every install that sends for its clients. The company must be who
   * runs the service, by both its name and its legal name (a runner left out is the company in full), and Forms refuses to set signing up for any other business.
   *
   * SET WHEN THE INSTALL IS CREATED AND NEVER FLIPPED ON A LIVE INSTALL. Envelopes already sent keep the words their signers were shown (the consent's hash is recorded with them), but a certificate reprints the consent
   * from the current words, and a business that was sent as a client of the service would be re-described as the company itself. Turning it off later is as wrong: documents sent as the company would read as another's.
   */
  ownCompanyOnly?: true
}

export interface Declaration {
  company: Company
  access: {
    /** The company's Zero Trust team domain, bare. */
    teamDomain: string
  }
  space: SpaceDeclaration
  forms: FormsDeclaration
  /** Where Forms' and Meet's mail comes from. Always present: declared, or the company's `forms@` and `meet@`. */
  senders: SendersDeclaration
  /** The signing service's name, contact and who runs it. Always present: declared, or the defaults named on `FormsServiceDeclaration`. */
  formsService: FormsServiceDeclaration
  /** Present exactly where the `gmail` switch is on, with `googleApp`. */
  gmailPush?: GmailPushDeclaration
  /** Present exactly where the `gmail` switch is on, with `gmailPush`. */
  googleApp?: GoogleAppDeclaration
  /** Present exactly where the `hostedMailboxes` switch is on, and then at least one. */
  hostedMailboxes?: HostedMailboxDeclaration[]
  /** The business mailboxes fed by Cloudflare Email Routing, when the install has any (each is also in a business's `mailboxes`). */
  cloudflareMailboxes?: CloudflareMailboxDeclaration[]
  /** Present exactly where the `phone` switch is on. */
  phone?: PhoneDeclaration
  /** Present only where the `claudeScript` switch is on. */
  agent?: AgentDeclaration
  /** Present exactly where the `telegram` switch is on. */
  telegram?: TelegramDeclaration
  /** Present exactly where the `clientDirectory` switch is on. */
  clientsDoor?: ClientsDoorDeclaration
  people: Person[]
  /** The public shared addresses (info@, estimates@) on the company's domain. */
  sharedAddresses: string[]
  /** Never empty: a declaration that lists none has one business, the company itself, with no mailboxes. */
  businesses: Business[]
  switches: Record<Switch, boolean>
}

export class DeclarationError extends Error {
  constructor(readonly problems: string[]) {
    super(`The company declaration is not valid:\n- ${problems.join('\n- ')}`)
    this.name = 'DeclarationError'
  }
}

const EMAIL = /^[a-z0-9][a-z0-9._+-]*@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/
const DOMAIN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/
const SLUG = /^[a-z0-9][a-z0-9-]*$/
export const TEAM_DOMAIN = /^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/
const DURATION = /^[1-9][0-9]*[hm]$/
const DOOR = /^\/[a-z0-9/_-]*[a-z0-9_-]$/
const HEX = /^#[0-9a-fA-F]{6}$/
const GOOGLE_CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/
const PUSH_TOPIC = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~%+-]{2,254}$/
const HTTPS_DOOR = /^https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(:[0-9]{1,5})?\/?$/
const SECRET_NAME = /^[A-Z][A-Z0-9_]{2,63}$/
const E164 = /^\+[1-9][0-9]{6,14}$/
/** The paths of the space that are its own: its API and its tabs. A machine's path is never one of these or under one. */
const RESERVED_PATHS = ['/api', ...TAB_IDS.map((t) => `/${t}`)]

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

function knownKeys(where: string, o: Obj, allowed: readonly string[], problems: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) problems.push(`${where}: unknown field "${k}"`)
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * The `people` of a declared mailbox (see `MailboxPeople`): a list of work addresses, each a person of this install, each once, and not empty (a mailbox nobody is on is not declared: leave `people` out for the
 * owner alone). Undefined where left out. Every problem is added to `problems`.
 */
function readMailboxPeople(where: string, given: unknown, people: readonly Person[], problems: string[]): string[] | undefined {
  if (given === undefined) return undefined
  if (!Array.isArray(given) || given.length === 0) {
    problems.push(`${where}.people: a list of the work addresses of the people on the mailbox, at least one, or leave it out for the owner alone`)
    return undefined
  }
  const out: string[] = []
  for (const p of given) {
    const a = typeof p === 'string' ? p.trim().toLowerCase() : ''
    if (!people.some((q) => q.address === a)) problems.push(`${where}.people: ${String(p)} is not a person of this install (people lists work addresses)`)
    else if (out.includes(a)) problems.push(`${where}.people: ${a} is listed twice`)
    else out.push(a)
  }
  return out
}

/** The declaration in `raw`, or a DeclarationError naming everything wrong with it. */
export function parseDeclaration(raw: unknown): Declaration {
  const problems: string[] = []
  if (!isObj(raw)) throw new DeclarationError(['the declaration is not an object'])
  knownKeys('declaration', raw, ['company', 'access', 'space', 'forms', 'senders', 'formsService', 'gmailPush', 'googleApp', 'hostedMailboxes', 'cloudflareMailboxes', 'phone', 'agent', 'telegram', 'clientsDoor', 'people', 'sharedAddresses', 'businesses', 'switches'], problems)

  // Company
  let company: Company = { id: '', name: '', domain: '', timeZone: '' }
  if (!isObj(raw.company)) problems.push('company: missing')
  else {
    const c = raw.company
    knownKeys('company', c, ['id', 'name', 'legalName', 'domain', 'timeZone', 'logo', 'colors'], problems)
    const id = str(c.id)
    const name = str(c.name)
    const domain = str(c.domain)?.toLowerCase() ?? null
    const timeZone = str(c.timeZone)
    if (id === null || !SLUG.test(id)) problems.push('company.id: a lowercase slug is required')
    if (name === null) problems.push('company.name: required')
    if (domain === null || !DOMAIN.test(domain)) problems.push('company.domain: a bare domain such as "example.com" is required')
    if (timeZone === null || !validTimeZone(timeZone)) problems.push('company.timeZone: an IANA time zone is required')
    if (c.legalName !== undefined && (str(c.legalName) === null || /[\r\n]/.test(String(c.legalName)))) problems.push('company.legalName: one line, or leave it out')
    if (c.logo !== undefined && str(c.logo) === null) problems.push('company.logo: a path or URL, or leave it out')
    let colors: Company['colors']
    if (c.colors !== undefined) {
      if (!isObj(c.colors)) problems.push('company.colors: an object')
      else {
        knownKeys('company.colors', c.colors, ['accent'], problems)
        const accent = c.colors.accent
        if (accent !== undefined && !(typeof accent === 'string' && HEX.test(accent))) {
          problems.push('company.colors.accent: a hex color such as "#1a2b3c"')
        }
        colors = typeof accent === 'string' ? { accent } : {}
      }
    }
    company = {
      id: id ?? '',
      name: name ?? '',
      ...(str(c.legalName) !== null ? { legalName: str(c.legalName) as string } : {}),
      domain: domain ?? '',
      timeZone: timeZone ?? '',
      ...(typeof c.logo === 'string' ? { logo: c.logo.trim() } : {}),
      ...(colors ? { colors } : {}),
    }
  }
  const onDomain = (addr: string) => company.domain !== '' && addr.endsWith(`@${company.domain}`)

  // Access
  let teamDomain = ''
  if (!isObj(raw.access)) problems.push('access: missing')
  else {
    knownKeys('access', raw.access, ['teamDomain'], problems)
    const t = str(raw.access.teamDomain)?.toLowerCase() ?? null
    if (t === null || !TEAM_DOMAIN.test(t)) problems.push('access.teamDomain: "<team>.cloudflareaccess.com", bare')
    else teamDomain = t
  }

  // Space
  let space: SpaceDeclaration = { host: '', sessionDuration: '' }
  if (!isObj(raw.space)) problems.push('space: missing')
  else {
    knownKeys('space', raw.space, ['host', 'sessionDuration'], problems)
    const host = str(raw.space.host)?.toLowerCase() ?? null
    if (host === null || !DOMAIN.test(host)) problems.push('space.host: a hostname is required')
    else if (company.domain !== '' && !host.endsWith(`.${company.domain}`)) {
      problems.push(`space.host: "${host}" is not under ${company.domain}`)
    }
    const sessionDuration = raw.space.sessionDuration
    if (typeof sessionDuration !== 'string' || !DURATION.test(sessionDuration)) {
      problems.push('space.sessionDuration: a duration such as "730h"')
    }
    space = { host: host ?? '', sessionDuration: typeof sessionDuration === 'string' ? sessionDuration : '' }
  }

  // Forms' sign-in: a day unless declared.
  let forms: FormsDeclaration = { sessionDuration: '24h' }
  if (raw.forms !== undefined) {
    if (!isObj(raw.forms)) problems.push('forms: an object')
    else {
      knownKeys('forms', raw.forms, ['sessionDuration'], problems)
      const d = raw.forms.sessionDuration === undefined ? '24h' : raw.forms.sessionDuration
      if (typeof d !== 'string' || !DURATION.test(d)) problems.push('forms.sessionDuration: a duration such as "24h"')
      else forms = { sessionDuration: d }
    }
  }

  // Shared addresses
  const sharedAddresses: string[] = []
  if (raw.sharedAddresses !== undefined) {
    if (!Array.isArray(raw.sharedAddresses)) problems.push('sharedAddresses: a list')
    else {
      for (const s of raw.sharedAddresses) {
        const a = typeof s === 'string' ? s.trim().toLowerCase() : ''
        if (!EMAIL.test(a)) problems.push(`sharedAddresses: "${String(s)}" is not an address`)
        else if (!onDomain(a)) problems.push(`sharedAddresses: ${a} is not on ${company.domain}`)
        else if (sharedAddresses.includes(a)) problems.push(`sharedAddresses: ${a} is listed twice`)
        else sharedAddresses.push(a)
      }
    }
  }

  // People
  const people: Person[] = []
  if (!Array.isArray(raw.people)) problems.push('people: a list is required')
  else {
    raw.people.forEach((p, i) => {
      const where = `people[${i}]`
      if (!isObj(p)) {
        problems.push(`${where}: an object is required`)
        return
      }
      knownKeys(where, p, ['address', 'name', 'signIn', 'mailName', 'role', 'sharedAddresses'], problems)
      const address = str(p.address)?.toLowerCase() ?? null
      if (address === null || !EMAIL.test(address)) {
        problems.push(`${where}.address: an address is required`)
        return
      }
      const name = str(p.name)
      if (name === null) problems.push(`${where}.name: required`)
      // The name goes into a From header, so it is one plain line with nothing that could end the name or the header.
      const mailName = p.mailName === undefined ? null : str(p.mailName)
      if (p.mailName !== undefined && (mailName === null || mailName.length > MAIL_NAME_MAX || /[\r\n<>",;]/.test(mailName))) {
        problems.push(`${where}.mailName: one line of at most ${MAIL_NAME_MAX} characters with no quote, angle bracket, comma or semicolon, or leave it out`)
      }
      const signIn = p.signIn === undefined ? address : (str(p.signIn)?.toLowerCase() ?? '')
      if (!EMAIL.test(signIn)) problems.push(`${where}.signIn: an address Access can send a code to`)
      if (!ROLES.includes(p.role as Role)) problems.push(`${where}.role: "owner" or "member"`)
      const mine: string[] = []
      if (p.sharedAddresses !== undefined) {
        if (!Array.isArray(p.sharedAddresses)) problems.push(`${where}.sharedAddresses: a list`)
        else {
          for (const s of p.sharedAddresses) {
            const a = typeof s === 'string' ? s.trim().toLowerCase() : ''
            if (!sharedAddresses.includes(a)) problems.push(`${where}.sharedAddresses: ${String(s)} is not a declared shared address`)
            else mine.push(a)
          }
        }
      }
      if (people.some((q) => q.address === address)) problems.push(`${where}: ${address} is listed twice`)
      if (people.some((q) => q.signIn === signIn)) problems.push(`${where}: sign-in address ${signIn} belongs to two people`)
      // Signing in as a@x must never be read as person B: a sign-in address that is another person's work address is refused.
      if (people.some((q) => q.address === signIn && q.address !== address)) {
        problems.push(`${where}.signIn: ${signIn} is another person's address`)
      }
      if (people.some((q) => q.signIn === address && q.address !== address)) {
        problems.push(`${where}.address: ${address} is another person's sign-in address`)
      }
      people.push({ address, name: name ?? '', signIn, ...(mailName !== null && { mailName }), role: p.role as Role, sharedAddresses: mine })
    })
    if (!people.some((p) => p.role === 'owner')) problems.push('people: at least one owner is required')
  }

  // Senders: the addresses Forms' and Meet's mail goes out from, on the company's own domain; the company's forms@ and meet@ unless declared.
  const senders: SendersDeclaration = { forms: `forms@${company.domain}`, meet: `meet@${company.domain}` }
  if (raw.senders !== undefined) {
    if (!isObj(raw.senders)) problems.push('senders: an object with forms and meet')
    else {
      knownKeys('senders', raw.senders, ['forms', 'meet'], problems)
      for (const app of ['forms', 'meet'] as const) {
        const given = raw.senders[app]
        if (given === undefined) continue
        const a = typeof given === 'string' ? given.trim().toLowerCase() : ''
        if (!EMAIL.test(a)) problems.push(`senders.${app}: an address is required`)
        else if (!onDomain(a)) problems.push(`senders.${app}: ${a} is not on ${company.domain}, the only domain the install can send from`)
        else senders[app] = a
      }
    }
  }
  if (senders.forms === senders.meet) problems.push('senders: Forms and Meet each send from an address of their own')

  // The signing service's words: its name, the address a person writes to, who runs it.
  const formsService: FormsServiceDeclaration = {
    name: `${company.name} Forms`,
    contact: '',
    runBy: { name: company.name, legalName: company.name, mailingLine: '', site: company.domain },
  }
  if (raw.formsService !== undefined) {
    if (!isObj(raw.formsService)) problems.push('formsService: an object')
    else {
      const f = raw.formsService
      knownKeys('formsService', f, ['name', 'contact', 'runBy', 'ownCompanyOnly'], problems)
      const line = (v: unknown, where: string, what: string): string | null => {
        const t = str(v)
        if (t === null || t.length > SERVICE_NAME_MAX || /[\r\n]/.test(t)) {
          problems.push(`${where}: ${what}, one line of at most ${SERVICE_NAME_MAX} characters`)
          return null
        }
        return t
      }
      if (f.name !== undefined) formsService.name = line(f.name, 'formsService.name', 'what the service is called ("Acme Forms")') ?? formsService.name
      if (f.contact !== undefined) {
        const a = typeof f.contact === 'string' ? f.contact.trim().toLowerCase() : ''
        if (!EMAIL.test(a)) problems.push('formsService.contact: an address a person can write to about the service and their information')
        else formsService.contact = a
      }
      if (f.runBy !== undefined) {
        if (!isObj(f.runBy)) problems.push('formsService.runBy: an object with a name, a legalName and a mailingLine')
        else {
          knownKeys('formsService.runBy', f.runBy, ['name', 'legalName', 'mailingLine', 'site'], problems)
          const name = f.runBy.name === undefined ? company.name : (line(f.runBy.name, 'formsService.runBy.name', 'who runs the service, as a person says it ("Acme")') ?? company.name)
          const legalName = f.runBy.legalName === undefined ? name : (line(f.runBy.legalName, 'formsService.runBy.legalName', 'who runs the service, as the law names it ("Acme LLC")') ?? name)
          // A mailing line may be empty (none: the footer then names the legal name alone), which is what a parsed declaration says when none was given, so a parsed declaration parses again.
          const mailingLine = f.runBy.mailingLine === undefined || f.runBy.mailingLine === '' ? '' : (line(f.runBy.mailingLine, 'formsService.runBy.mailingLine', 'the mailing line of the email footer ("Alder Bend, Oregon")') ?? '')
          let site = company.domain
          if (f.runBy.site !== undefined) {
            const t = typeof f.runBy.site === 'string' ? f.runBy.site.trim().toLowerCase() : ''
            if (!DOMAIN.test(t)) problems.push('formsService.runBy.site: a bare domain such as "example.com"')
            else site = t
          }
          formsService.runBy = { name, legalName, mailingLine, site }
        }
      }
      if (f.ownCompanyOnly !== undefined) {
        if (typeof f.ownCompanyOnly !== 'boolean') problems.push('formsService.ownCompanyOnly: true or false (true when this install\'s Forms sends only for its own company)')
        else if (f.ownCompanyOnly) {
          // The company's own service is run by the company: another company as runner is a second party, which is what the flag says there is none of.
          // A runner left out, or one that names the company but not its legal name, is the company in full: its legal name is the company's.
          const legal = company.legalName ?? company.name
          const r = formsService.runBy
          if (r.name === company.name && !(isObj(f.runBy) && f.runBy.legalName !== undefined)) r.legalName = legal
          // Its site is the company's domain (left out, it is), since the landing page links to who runs the service.
          if (r.name !== company.name || r.legalName !== legal || r.site !== company.domain) problems.push('formsService.ownCompanyOnly: the company must be who runs the service, by its name, its legal name and its site (leave runBy out, or name the company)')
          formsService.ownCompanyOnly = true
        }
      }
    }
  }

  // The address a signer writes to about the service and their information is published (the signer's page, the privacy notice, the service's own answer), so it is a decision of the install and is never taken from a
  // person's own address: an install's Forms is a tab of its space, so every declaration says it.
  if (formsService.contact === '') problems.push('formsService.contact: required, the address a person writes to about the signing service and their information (it is published, so it is not taken from the owner\'s own address)')

  // Businesses
  const businesses: Business[] = []
  if (raw.businesses !== undefined) {
    if (!Array.isArray(raw.businesses)) problems.push('businesses: a list')
    else {
      raw.businesses.forEach((b, i) => {
        const where = `businesses[${i}]`
        if (!isObj(b)) {
          problems.push(`${where}: an object is required`)
          return
        }
        knownKeys(where, b, ['id', 'name', 'mailboxes'], problems)
        const id = str(b.id)
        const name = str(b.name)
        if (id === null || !SLUG.test(id)) problems.push(`${where}.id: a lowercase slug is required`)
        else if (businesses.some((q) => q.id === id)) problems.push(`${where}.id: "${id}" is listed twice`)
        if (name === null) problems.push(`${where}.name: required`)
        const mailboxes: string[] = []
        if (b.mailboxes !== undefined) {
          if (!Array.isArray(b.mailboxes)) problems.push(`${where}.mailboxes: a list`)
          else {
            for (const m of b.mailboxes) {
              const a = typeof m === 'string' ? m.trim().toLowerCase() : ''
              if (!EMAIL.test(a)) problems.push(`${where}.mailboxes: "${String(m)}" is not an address`)
              else if (mailboxes.includes(a)) problems.push(`${where}.mailboxes: ${a} is listed twice`)
              else if (businesses.some((q) => q.mailboxes.includes(a))) {
                problems.push(`${where}.mailboxes: ${a} is already another business's mailbox`)
              } else mailboxes.push(a)
            }
          }
        }
        businesses.push({ id: id ?? '', name: name ?? '', mailboxes })
      })
    }
  }
  // The default: the company itself is the one business, with no mailboxes.
  if (businesses.length === 0) businesses.push({ id: company.id, name: company.name, mailboxes: [] })

  // Switches
  const switches = { ...SWITCH_DEFAULTS }
  if (raw.switches !== undefined) {
    if (!isObj(raw.switches)) problems.push('switches: an object')
    else {
      knownKeys('switches', raw.switches, SWITCHES, problems)
      for (const s of SWITCHES) {
        const v = raw.switches[s]
        if (v === undefined) continue
        if (typeof v !== 'boolean') problems.push(`switches.${s}: true or false`)
        else {
          switches[s] = v
        }
      }
    }
  }

  // What each switch needs: the settings that make it whole. A switch is allowed in any install that gives them and refused without them, and a setting is refused where its switch is off, so a declaration says
  // exactly what it runs. `calls` and `manyClients` need nothing. The doors (Claude's, the bridge's, the Clients door) are read below with the same rule.
  //
  // Gmail: the machine host Google delivers the push to, and the install's own Google app (its client id and the topic the watch publishes to).
  let gmailPush: GmailPushDeclaration | undefined
  if (raw.gmailPush !== undefined) {
    if (!switches.gmail) problems.push('gmailPush: only where the gmail switch is on; the push address is what Gmail needs')
    if (!isObj(raw.gmailPush)) problems.push('gmailPush: an object')
    else {
      knownKeys('gmailPush', raw.gmailPush, ['host'], problems)
      const host = str(raw.gmailPush.host)?.toLowerCase() ?? null
      if (host === null || !DOMAIN.test(host)) problems.push('gmailPush.host: a hostname is required')
      else if (company.domain !== '' && !host.endsWith(`.${company.domain}`)) problems.push(`gmailPush.host: "${host}" is not under ${company.domain}`)
      else if (host === space.host) problems.push('gmailPush.host: the push address is a name of its own, apart from the space\'s')
      else gmailPush = { host }
    }
  } else if (switches.gmail) {
    problems.push('gmailPush: the gmail switch is on, so the address Google delivers the push to is required')
  }
  let googleApp: GoogleAppDeclaration | undefined
  if (raw.googleApp !== undefined) {
    if (!switches.gmail) problems.push('googleApp: only where the gmail switch is on; the Google app is what Gmail needs')
    if (!isObj(raw.googleApp)) problems.push('googleApp: an object')
    else {
      knownKeys('googleApp', raw.googleApp, ['clientId', 'pushTopic'], problems)
      const clientId = str(raw.googleApp.clientId)
      const pushTopic = str(raw.googleApp.pushTopic)
      const idOk = clientId !== null && GOOGLE_CLIENT_ID.test(clientId)
      const topicOk = pushTopic !== null && PUSH_TOPIC.test(pushTopic)
      if (!idOk) problems.push('googleApp.clientId: the Google OAuth web client\'s id, "<number>-<name>.apps.googleusercontent.com"')
      if (!topicOk) problems.push('googleApp.pushTopic: the Pub/Sub topic Gmail\'s watch publishes to, "projects/<project>/topics/<topic>"')
      if (idOk && topicOk) googleApp = { clientId, pushTopic }
    }
  } else if (switches.gmail) {
    problems.push('googleApp: the gmail switch is on, so the install\'s own Google app (its client id and the topic Gmail\'s watch publishes to) is required')
  }

  // Mailboxes on the install's own mail server: at least one, each with the door of its JMAP server and the name of the secret that holds its key.
  let hostedMailboxes: HostedMailboxDeclaration[] | undefined
  if (raw.hostedMailboxes !== undefined) {
    if (!switches.hostedMailboxes) problems.push('hostedMailboxes: only where the hostedMailboxes switch is on')
    if (!Array.isArray(raw.hostedMailboxes)) problems.push('hostedMailboxes: a list of { address, name, door, secret, people? }')
    else {
      const list: HostedMailboxDeclaration[] = []
      raw.hostedMailboxes.forEach((m, i) => {
        const where = `hostedMailboxes[${i}]`
        if (!isObj(m)) {
          problems.push(`${where}: an object is required`)
          return
        }
        knownKeys(where, m, ['address', 'name', 'door', 'secret', 'people'], problems)
        const address = str(m.address)?.toLowerCase() ?? null
        const name = str(m.name)
        const door = typeof m.door === 'string' ? m.door : null
        const secret = typeof m.secret === 'string' ? m.secret : null
        const addressOk = address !== null && EMAIL.test(address)
        const nameOk = name !== null && !/[\r\n]/.test(name)
        const doorOk = door !== null && HTTPS_DOOR.test(door)
        const secretOk = secret !== null && SECRET_NAME.test(secret)
        if (!addressOk) problems.push(`${where}.address: an address is required`)
        else if (list.some((q) => q.address === address)) problems.push(`${where}.address: ${address} is listed twice`)
        if (!nameOk) problems.push(`${where}.name: one line, required`)
        if (!doorOk) problems.push(`${where}.door: an https address with a hostname and nothing after it`)
        if (!secretOk) problems.push(`${where}.secret: the name of the Worker secret that holds the key, upper case, never the key`)
        const onIt = readMailboxPeople(where, m.people, people, problems)
        if (addressOk && nameOk && doorOk && secretOk) list.push({ address, name, door, secret, ...(onIt !== undefined && { people: onIt }) })
      })
      hostedMailboxes = list
    }
  }
  if (switches.hostedMailboxes && (hostedMailboxes === undefined || hostedMailboxes.length === 0)) {
    problems.push('hostedMailboxes: the hostedMailboxes switch is on, so at least one mailbox on the install\'s mail server (address, name, door, secret) is required')
  }

  // Mailboxes fed by Cloudflare Email Routing: each is one of a business's, on a domain of its own (the catch-all makes the domain the mailbox), and is not the owner's own address (the owner's Gmail is not declared here).
  let cloudflareMailboxes: CloudflareMailboxDeclaration[] | undefined
  if (raw.cloudflareMailboxes !== undefined) {
    if (!Array.isArray(raw.cloudflareMailboxes)) problems.push('cloudflareMailboxes: a list of { address, name, short?, spamCheck?, people? }')
    else {
      const list: CloudflareMailboxDeclaration[] = []
      const owner = people.find((p) => p.role === 'owner')
      raw.cloudflareMailboxes.forEach((m, i) => {
        const where = `cloudflareMailboxes[${i}]`
        if (!isObj(m)) {
          problems.push(`${where}: an object is required`)
          return
        }
        knownKeys(where, m, ['address', 'name', 'short', 'spamCheck', 'people'], problems)
        const address = str(m.address)?.toLowerCase() ?? null
        const name = str(m.name)
        const short = m.short === undefined ? undefined : str(m.short)
        if (address === null || !EMAIL.test(address)) problems.push(`${where}.address: an address is required`)
        else {
          if (list.some((q) => q.address === address)) problems.push(`${where}.address: ${address} is listed twice`)
          else if (list.some((q) => q.address.split('@')[1] === address.split('@')[1])) problems.push(`${where}.address: a domain's mail has one mailbox, and ${address.split('@')[1]} has one already`)
          if (owner !== undefined && (address === owner.address || address === owner.signIn)) problems.push(`${where}.address: ${address} is the owner's own address, which is the Gmail mailbox and is not declared here`)
          if (!businesses.some((b) => b.mailboxes.includes(address))) problems.push(`${where}.address: ${address} is not a mailbox of any business (add it to a business's mailboxes)`)
        }
        if (name === null || /[\r\n]/.test(name)) problems.push(`${where}.name: one line, required`)
        if (short === null || (short !== undefined && /[\r\n]/.test(short))) problems.push(`${where}.short: one line`)
        if (m.spamCheck !== undefined && typeof m.spamCheck !== 'boolean') problems.push(`${where}.spamCheck: true or false`)
        const onIt = readMailboxPeople(where, m.people, people, problems)
        if (address !== null && EMAIL.test(address) && name !== null && !/[\r\n]/.test(name) && short !== null) {
          list.push({ address, name, ...(short !== undefined && { short }), ...(m.spamCheck === true && { spamCheck: true }), ...(onIt !== undefined && { people: onIt }) })
        }
      })
      cloudflareMailboxes = list
    }
  }

  // The phone: who has the dial pad, and the number each person's 911 calls leave from.
  let phone: PhoneDeclaration | undefined
  if (raw.phone !== undefined) {
    if (!switches.phone) problems.push('phone: only where the phone switch is on')
    if (!isObj(raw.phone)) problems.push('phone: an object')
    else {
      knownKeys('phone', raw.phone, ['people'], problems)
      const listed: PhoneDeclaration['people'] = {}
      const given = raw.phone.people
      if (!isObj(given) || Object.keys(given).length === 0) {
        problems.push('phone.people: at least one person with the dial pad, by work address, each with the number their 911 calls leave from')
      } else {
        for (const [who, v] of Object.entries(given)) {
          const where = `phone.people.${who}`
          if (!people.some((q) => q.address === who)) problems.push(`${where}: not a person of this install (the key is a work address in people)`)
          if (!isObj(v)) {
            problems.push(`${where}: an object with emergencyNumber`)
            continue
          }
          knownKeys(where, v, ['emergencyNumber'], problems)
          const n = v.emergencyNumber
          if (n !== 'line' && !(typeof n === 'string' && E164.test(n))) problems.push(`${where}.emergencyNumber: "line" (the install's own number) or a number of their own in E.164, such as "+16265550100"`)
          else listed[who] = { emergencyNumber: n }
        }
        if (Object.values(given).filter((v) => isObj(v) && v.emergencyNumber === 'line').length > 1) {
          problems.push('phone.people: the line holds one registered address, so one person only may use "line"; another needs a number of their own')
        }
      }
      phone = { people: listed }
    }
  } else if (switches.phone) {
    problems.push('phone: the phone switch is on, so who has the dial pad (phone.people) is required')
  }

  // The assistant drafts for a business's mailbox: with none declared there is nothing for it to work on.
  if (switches.assistant && !businesses.some((b) => b.mailboxes.length > 0)) {
    problems.push('switches.assistant: the assistant drafts for a business mailbox, so at least one is required in businesses')
  }

  // Claude's door: a path of the space, only where the claudeScript switch is on (a client's inbox admits no token). The name of the token it admits is the install file's.
  let agent: AgentDeclaration | undefined
  if (raw.agent !== undefined) {
    if (!switches.claudeScript) problems.push('agent: the claudeScript switch must be on for the inbox to admit a service token')
    if (!isObj(raw.agent)) problems.push('agent: an object')
    else {
      knownKeys('agent', raw.agent, ['path'], problems)
      const path = typeof raw.agent.path === 'string' ? raw.agent.path : null
      let pathOk = false
      if (path === null || !DOOR.test(path)) {
        problems.push('agent.path: a path of the space such as "/agent/inbox" with no trailing slash')
      } else if (RESERVED_PATHS.some((r) => path === r || path.startsWith(`${r}/`))) {
        problems.push(`agent.path: ${path} is the space's own (its API or a tab), and no machine may be let in there`)
      } else pathOk = true
      if (pathOk && path !== null) agent = { path }
    }
  } else if (switches.claudeScript) {
    problems.push('agent: the claudeScript switch is on, so the path Claude is let in on is required')
  }

  // The Telegram bridge's door: the same shape as Claude's, a path of its own, and required where the switch is on. The two doors never share a path (one inside the other would be
  // answered by the wrong Access application); that they never share a token either is the install file's check (kit).
  let telegram: TelegramDeclaration | undefined
  if (raw.telegram !== undefined) {
    if (!switches.telegram) problems.push('telegram: only where the telegram switch is on; no other install has a bridge')
    if (!isObj(raw.telegram)) problems.push('telegram: an object')
    else {
      knownKeys('telegram', raw.telegram, ['path'], problems)
      const path = typeof raw.telegram.path === 'string' ? raw.telegram.path : null
      let pathOk = false
      if (path === null || !DOOR.test(path)) {
        problems.push('telegram.path: a path of the space such as "/agent/telegram" with no trailing slash')
      } else if (RESERVED_PATHS.some((r) => path === r || path.startsWith(`${r}/`))) {
        problems.push(`telegram.path: ${path} is the space's own (its API or a tab), and no machine may be let in there`)
      } else if (agent !== undefined && (path === agent.path || path.startsWith(`${agent.path}/`) || agent.path.startsWith(`${path}/`))) {
        problems.push(`telegram.path: ${path} is Claude's door or inside it (or contains it); each machine has a path of its own`)
      } else pathOk = true
      if (pathOk && path !== null) telegram = { path }
    }
  } else if (switches.telegram) {
    problems.push('telegram: the telegram switch is on, so the bridge\'s path is required')
  }

  // The Clients door: a third machine path, required where the clientDirectory switch is on. It is held apart from the other two doors as they are held apart from each other (a path inside
  // another door would be answered by the wrong Access application; its token is its own too, the install file's check), and it names the source its Clients are from.
  let clientsDoor: ClientsDoorDeclaration | undefined
  if (raw.clientsDoor !== undefined) {
    if (!switches.clientDirectory) problems.push('clientsDoor: only where the clientDirectory switch is on; an install with no outside system makes its Clients in its own space')
    if (!isObj(raw.clientsDoor)) problems.push('clientsDoor: an object')
    else {
      knownKeys('clientsDoor', raw.clientsDoor, ['path', 'source', 'suggestByAddressKey', 'fields'], problems)
      const path = typeof raw.clientsDoor.path === 'string' ? raw.clientsDoor.path : null
      const source = str(raw.clientsDoor.source)
      let pathOk = false
      const others = [agent, telegram].filter((d): d is AgentDeclaration => d !== undefined)
      if (path === null || !DOOR.test(path)) {
        problems.push('clientsDoor.path: a path of the space such as "/agent/clients" with no trailing slash')
      } else if (RESERVED_PATHS.some((r) => path === r || path.startsWith(`${r}/`))) {
        problems.push(`clientsDoor.path: ${path} is the space's own (its API or a tab), and no machine may be let in there`)
      } else if (others.some((d) => path === d.path || path.startsWith(`${d.path}/`) || d.path.startsWith(`${path}/`))) {
        problems.push(`clientsDoor.path: ${path} is another machine's door or inside it (or contains it); each machine has a path of its own`)
      } else pathOk = true
      if (source === null || source.length > CLIENT_SOURCE_NAME_MAX || /[\r\n]/.test(source)) {
        problems.push(`clientsDoor.source: one line of at most ${CLIENT_SOURCE_NAME_MAX} characters naming where the Clients are from, such as "example.com"`)
      }
      const before = problems.length
      let suggestByAddressKey: string | undefined
      if (raw.clientsDoor.suggestByAddressKey !== undefined) {
        const key = raw.clientsDoor.suggestByAddressKey
        if (typeof key !== 'string' || !CLIENT_EXTRA_KEY.test(key)) problems.push('clientsDoor.suggestByAddressKey: the key of one of the source\'s extra fields, such as "contactAddress"')
        else suggestByAddressKey = key
      }
      let fields: Record<string, ClientFieldDeclaration> | undefined
      if (raw.clientsDoor.fields !== undefined) {
        if (!isObj(raw.clientsDoor.fields)) problems.push('clientsDoor.fields: an object of labels by the key of the source\'s extra field')
        else {
          fields = {}
          for (const [key, f] of Object.entries(raw.clientsDoor.fields)) {
            const where = `clientsDoor.fields.${key}`
            if (!CLIENT_EXTRA_KEY.test(key)) problems.push(`${where}: not a key an extra field may have`)
            if (!isObj(f)) {
              problems.push(`${where}: an object with a label`)
              continue
            }
            knownKeys(where, f, ['label', 'kind', 'list'], problems)
            const label = str(f.label)
            if (label === null || label.length > CLIENT_FIELD_LABEL_MAX || /[\r\n]/.test(label)) {
              problems.push(`${where}.label: one line of at most ${CLIENT_FIELD_LABEL_MAX} characters`)
              continue
            }
            if (f.kind !== undefined && !CLIENT_FIELD_KINDS.includes(f.kind as ClientFieldKind)) problems.push(`${where}.kind: one of ${CLIENT_FIELD_KINDS.join(', ')}`)
            if (f.list !== undefined && typeof f.list !== 'boolean') problems.push(`${where}.list: true or false`)
            fields[key] = { label, ...(f.kind !== undefined && { kind: f.kind as ClientFieldKind }), ...(f.list !== undefined && { list: f.list as boolean }) }
          }
        }
      }
      if (pathOk && path !== null && source !== null && source.length <= CLIENT_SOURCE_NAME_MAX && !/[\r\n]/.test(source) && problems.length === before) {
        clientsDoor = { path, source, ...(suggestByAddressKey !== undefined && { suggestByAddressKey }), ...(fields !== undefined && { fields }) }
      }
    }
  } else if (switches.clientDirectory) {
    problems.push('clientsDoor: the clientDirectory switch is on, so the path and the source of the Clients that arrive are required')
  }

  if (problems.length > 0) throw new DeclarationError(problems)
  return {
    company,
    access: { teamDomain },
    space,
    forms,
    senders,
    formsService,
    ...(gmailPush ? { gmailPush } : {}),
    ...(googleApp ? { googleApp } : {}),
    ...(hostedMailboxes ? { hostedMailboxes } : {}),
    ...(cloudflareMailboxes ? { cloudflareMailboxes } : {}),
    ...(phone ? { phone } : {}),
    ...(agent ? { agent } : {}),
    ...(telegram ? { telegram } : {}),
    ...(clientsDoor ? { clientsDoor } : {}),
    people,
    sharedAddresses,
    businesses,
    switches,
  }
}
