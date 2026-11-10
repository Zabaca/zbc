/**
 * The public check: what must not be in the space's code, tests, comments and docs, because they are published.
 *
 * It looks for four kinds of thing and carries no list of names. Anything that is not a reserved example or a named third party's service is a finding, so it needs no knowledge of who the real people and
 * companies are (that is a private list, checked elsewhere):
 *
 *  - address: an email address, or a hostname, whose domain is neither reserved nor a third party the code legitimately talks to;
 *  - hex-id: a 32-character hex string, the shape of a Cloudflare account, zone, database or application id, that is not obviously invented;
 *  - phone: a phone number outside the reserved 555-01xx range;
 *  - record: a reference to a record the reader cannot open (a private repository's problems, decisions, client files, environments, or a phrase that says which record a choice came from).
 *
 * What it finds, what it allows and how it tells a host from a property or a file name are all in this file and its source-context scanner; the documents that describe the check point here and do not repeat it.
 * A check is a pure function over one file's path and text (`checkPublic`), so it is tested on made-up lines. Reading a tree and printing the report are `check-tree.ts`; the command is `scripts/public-check.ts`.
 * Until the count is zero it reports and fails nothing; a later change turns `checkPublicFiles` over the folder into a failing test.
 */
import type { Hit, SourceFile } from './check-tree'
import { CODE, COMMENT, STRING, classify, type FileKind } from './source-context'

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Allowlists. Data, each entry with its reason, so adding one is a visible decision.
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** Top-level domains reserved for examples (RFC 2606, RFC 6761): nothing under them is real. */
export const RESERVED_TLDS = ['example', 'test', 'invalid', 'localhost'] as const

/** Domains reserved for examples (RFC 2606): they and everything under them are safe to name. */
export const RESERVED_DOMAINS = ['example.com', 'example.org', 'example.net'] as const

/**
 * Third parties' hosts the code talks to or must recognise: a domain, and everything under it, is allowed, as a host and in an address. A key that begins with `=` is that host alone, with nothing under it. Each
 * entry is a service the code calls, a name the code must recognise (a bulk-mail platform's bounce domain, a calendar's own ids) or a standard; a third party's own page that someone linked is not one.
 */
export const THIRD_PARTY_DOMAINS: Record<string, string> = {
  'cloudflare.com': 'Cloudflare: API, dashboard, documentation and CDN hosts',
  'cloudflarestorage.com': 'Cloudflare R2: the S3-compatible endpoint',
  'cloudflare-dns.com': 'Cloudflare: public resolver',
  'cloudflare.net': 'Cloudflare Email Routing: the mail exchanger hosts',
  'trycloudflare.com': 'Cloudflare: quick tunnels',
  'googleapis.com': 'Google: API hosts (Gmail, Calendar, Pub/Sub, OAuth, push)',
  '=accounts.google.com': 'Google: sign-in and consent',
  '=myaccount.google.com': 'Google: where a person reviews the access an app was given',
  '=console.cloud.google.com': 'Google Cloud: the console the setup guides send an operator to',
  '=cloud.google.com': 'Google Cloud: documentation the setup guides cite',
  '=developers.google.com': 'Google: API documentation the code cites',
  '=support.google.com': 'Google: help articles the setup guides cite',
  '=mail.google.com': 'Gmail: the web app, which the code links a person into',
  '=calendar.google.com': 'Google Calendar: the web app, which the code links a person into',
  '=group.calendar.google.com': 'Google Calendar: the domain of a shared calendar’s own id',
  '=group.v.calendar.google.com': 'Google Calendar: the domain of a calendar group’s own id',
  '=meet.google.com': 'Google Meet: the call links the calendar must recognise',
  '=google.com': 'Google: the bare domain, as a name the code compares with',
  '=googleusercontent.com': 'Google: the bare domain, as a name the code compares with',
  'gstatic.com': 'Google: static assets and fonts',
  '=mail.gmail.com': 'Gmail: the domain of every Message-ID it makes, whose local part is random',
  '=web.telegram.org': 'Telegram: the web client the bridge’s setup guide sends an operator to',
  '=en.wikipedia.org': 'A public page the link parser’s tests use as an ordinary link',
  'system.gserviceaccount.com': 'Google: the service accounts Google itself owns (Gmail’s push publisher)',
  'telnyx.com': 'Telnyx: API and SIP hosts',
  'anthropic.com': 'Anthropic: the API the assistant calls',
  'github.com': 'GitHub: public repositories and documentation; the owner in a path is checked separately (`GITHUB_OWNERS`)',
  'githubusercontent.com': 'GitHub: raw files; the owner in a path is checked separately (`GITHUB_OWNERS`)',
  'adobe.com': 'Adobe: the XMP and PDF namespace URLs a document carries',
  'sil.org': 'SIL: the font licence’s address',
  'biomejs.dev': 'Biome: the `$schema` URL of its configuration',
  'npmjs.com': 'npm: the package registry',
  'npmjs.org': 'npm: the package registry',
  'yarnpkg.com': 'The package registry',
  'unpkg.com': 'A package CDN',
  'jsdelivr.net': 'A package CDN',
  'w3.org': 'W3C: namespaces and specifications (the SVG and XHTML namespaces are URLs)',
  'schema.org': 'Structured data vocabulary',
  'ietf.org': 'IETF: RFCs',
  'rfc-editor.org': 'RFCs',
  'mozilla.org': 'Mozilla: MDN documentation',
  'mozilla.com': 'Mozilla: the push service host',
  'whatwg.org': 'WHATWG: living standards',
  'iana.org': 'IANA: reserved names and registries',
  'json-schema.org': 'JSON Schema: the `$schema` URLs',
  'apple.com': 'Apple: the web push service host',
  'microsoft.com': 'Microsoft: documentation and sign-in hosts',
  'windows.com': 'Microsoft: the web push service host',
  'office.com': 'Microsoft: mail and calendar hosts',
  'office365.com': 'Microsoft: mail hosts',
  'microsoftonline.com': 'Microsoft: sign-in hosts',
}

/**
 * Mail providers' domains, allowed as a bare host because code names them as logic (a rule about Gmail accounts, a list of providers that sign in elsewhere). Not allowed inside an address, because a name at a
 * provider's domain is a realistic person's address and invented people use a reserved domain; the one exception is a name no person can hold (`isPlaceholderMailbox`), for the tests of that logic.
 */
export const MAIL_PROVIDER_DOMAINS: Record<string, string> = {
  'gmail.com': 'Google mail: a Gmail account signs in through Google, not by code',
  'googlemail.com': 'Google mail: the same accounts under the older domain',
  'outlook.com': 'Microsoft mail',
  'hotmail.com': 'Microsoft mail',
  'live.com': 'Microsoft mail',
  'msn.com': 'Microsoft mail',
  'yahoo.com': 'Yahoo mail',
  'icloud.com': 'Apple mail',
  'me.com': 'Apple mail',
  'proton.me': 'Proton mail',
  'protonmail.com': 'Proton mail',
  'aol.com': 'AOL mail',
  'qq.com': 'QQ mail',
}

/**
 * Domains under which each customer of a service has a name of its own, so the name before the domain is whose it is. The bare domain is allowed, and under it only an invented name (or a listed real third party):
 * a real team's, account's or project's name is a real company's. `deeper` says whether labels below that name are the customer's own free choice (a Worker's name under its account's), or part of the name.
 */
export const TENANT_DOMAINS: Record<string, { reason: string; deeper: boolean; real?: Record<string, string> }> = {
  'cloudflareaccess.com': { reason: 'Cloudflare Access: `<team>.cloudflareaccess.com` is one company’s sign-in host', deeper: false },
  'workers.dev': { reason: 'Cloudflare Workers: `<worker>.<account>.workers.dev` carries the account’s name', deeper: true },
  'pages.dev': { reason: 'Cloudflare Pages: `<branch>.<project>.pages.dev` carries the project’s name', deeper: true },
  'iam.gserviceaccount.com': { reason: 'Google: `<project>.iam.gserviceaccount.com` names one cloud project', deeper: false },
  'apps.googleusercontent.com': { reason: 'Google: `<client id>.apps.googleusercontent.com` is one OAuth client', deeper: false },
  'zoom.us': { reason: 'Zoom: `<company>.zoom.us` is one company’s vanity host, and the bare domain is where the call links the calendar must recognise live', deeper: false },
  'beehiiv.com': { reason: 'Beehiiv: `<publication>.beehiiv.com` is one publication; `unsub` is the unsubscribe host the code recognises as machine mail', deeper: false, real: { unsub: 'the unsubscribe host' } },
  'customer.io': { reason: 'Customer.io: `<customer>.customer.io` is one customer’s; `bounces` and `unsubscribe` are the machine-mail hosts the code recognises', deeper: false, real: { bounces: 'the bounce host', unsubscribe: 'the unsubscribe host', unsubscribe2: 'the second unsubscribe host' } },
  'sendgrid.net': { reason: 'SendGrid: a customer’s own hosts live under it; `mail` and `bounces` are the machine-mail hosts the code recognises', deeper: false, real: { mail: 'the mail host', bounces: 'the bounce host' } },
  'craigslist.org': { reason: 'Craigslist: `<city>.craigslist.org`; `reply` and `sale` are the anonymised relay hosts of a listing, which the code must treat as a stranger’s', deeper: false, real: { reply: 'the reply relay', sale: 'the sale relay' } },
  'github.io': { reason: 'GitHub Pages: `<user>.github.io` is one person’s or organisation’s site', deeper: false, real: { notofonts: 'The Noto fonts project, whose documentation the bundled font’s notes cite' } },
}

/**
 * A name at a mail provider that is nobody's mailbox, which a test of provider logic may use: at most three characters before any `+` tag (`a@`, `ab@`, `a.b@`: shorter than any provider gives out today), or, at
 * Gmail, a name with an underscore or a hyphen, which Gmail does not allow in an account's name (`tessa_marlow@gmail.com`).
 */
export const isPlaceholderMailbox = (name: string, domain: string): boolean => {
  const host = domain.toLowerCase()
  if (!(host in MAIL_PROVIDER_DOMAINS)) return false
  const account = name.split('+')[0] ?? ''
  if (account.length <= 3) return true
  return (host === 'gmail.com' || host === 'googlemail.com') && /[_-]/.test(account)
}

/** The names a test or a doc may use under a tenant domain: the invented companies, and the placeholders a reader replaces. An invented company's name may carry more after a hyphen (`northfield-mail-000000`). */
export const INVENTED_TENANTS = ['northfield', 'brightwater', 'yourcompany', 'your-company', 'example', 'team', 'your-team', 'yourteam', 'myteam', 'my-team', 'proj', 'project', 'your-project', 'my-project', 'client-id', 'your-client-id', 'user', 'your-user'] as const

/**
 * The repositories of the code's author that the code may point to (the deploy tool, its engine, the public copy of the space), written as the address is. Exactly these: a repository whose name only begins
 * with one of them is another repository.
 */
export const AUTHOR_REPOSITORIES = ['github.com/Zabaca/zbc', 'github.com/Zabaca/zbc-core', 'github.com/Zabaca/zbc-space'] as const

/** Organisations other than the author whose repositories the code names, each with why. An owner not here is a finding, whoever it is. */
export const GITHUB_OWNERS: Record<string, string> = {
  notofonts: 'The Noto fonts project: the bundled font’s source',
}

/** An OAuth client id that counts up (`123456789012-abc…`), is all zeros, or is one digit and one letter is invented; a real one is a long number and random letters. */
const INVENTED_CLIENT_ID = /^(?:123456789\d*|0+|1)-[a-z]+$/

/** An invented company's name with more after a hyphen, as a project or a team would be named for it. */
const INVENTED_COMPANY_TENANT = /^(?:northfield|brightwater)-[a-z0-9-]+$/

/** Names that begin a property chain in code, never a host: `import.meta.env.DEV`, `this.app`, `env.AI`. */
const CODE_ROOTS = new Set(['import', 'this', 'process', 'window', 'document', 'globalthis', 'env', 'options', 'console', 'ctx', 'self', 'props', 'state'])

/**
 * Hex ids that are obviously invented. The rule also allows any value made of one short block repeated (`0000…`, `abababab…`, `0123456789abcdef` twice); these are the sequential ones it cannot see.
 */
export const INVENTED_HEX_IDS = ['0123456789abcdef0123456789abcdef', 'abcdef0123456789abcdef0123456789', 'deadbeefdeadbeefdeadbeefdeadbeef', '0123456789abcdeffedcba9876543210'] as const

/** Files in which a long hex string is expected and is no one's id: lockfiles, source maps, minified bundles. (Build output is not scanned at all.) */
export const HASH_FILES = /(?:^|\/)(?:bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json)$|\.map$|\.min\.(?:js|css)$/

/** Where a home directory's name is generic and so safe: `/Users/you`, `/home/runner`. */
export const GENERIC_HOME_NAMES = ['you', 'user', 'username', 'name', 'me', 'example', 'yourname', 'runner', 'node', 'app', 'ubuntu', 'sandbox', 'shared', 'agent', 'bun'] as const

/** The only files exempt from the check: its own tests, which are made of offending lines on purpose. */
export const EXEMPT_FILES = /(?:^|\/)test\/public-check\.test\.ts$/

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Addresses and hosts
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const endsWithDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

/** Whether a host is a listed third party's: the domain and everything under it, or for a `=` entry that host alone. */
const isThirdParty = (host: string): boolean => Object.keys(THIRD_PARTY_DOMAINS).some((allowed) => (allowed.startsWith('=') ? host === allowed.slice(1) : endsWithDomain(host, allowed)))

/** Whether a domain is safe to name: reserved, or a listed third party, or (as a bare host only) a mail provider. */
export const domainAllowed = (domain: string, options: { inAddress: boolean }): boolean => {
  const host = domain.toLowerCase().replace(/\.$/, '')
  const tld = host.slice(host.lastIndexOf('.') + 1)
  const reservedSuffix = (RESERVED_TLDS as readonly string[]).includes(tld) ? 1 : RESERVED_DOMAINS.some((reserved) => endsWithDomain(host, reserved)) ? 2 : 0
  if (reservedSuffix > 0) {
    // A reserved ending makes a name safe only when nothing before it is a real host with a real ending (a real name and its ending, then a reserved suffix after them).
    // A mail provider's or a listed third party's own domain there is a test of telling it from a name that only begins with it (`gmail.com.example`, `google.com.example`), and names no one.
    const before = host.split('.').slice(0, -reservedSuffix)
    if (before.join('.') in MAIL_PROVIDER_DOMAINS || isThirdParty(before.join('.'))) return true
    return !(before.length >= 2 && REAL_ENDINGS.has(before[before.length - 1] ?? ''))
  }
  const tenant = Object.keys(TENANT_DOMAINS).find((candidate) => endsWithDomain(host, candidate))
  if (tenant) {
    const labels = host.slice(0, -tenant.length).replace(/\.$/, '').split('.').filter(Boolean)
    const name = labels[labels.length - 1] ?? ''
    const rule = TENANT_DOMAINS[tenant]!
    if (name === '') return true
    if (labels.length > 1 && !rule.deeper) return false
    return (INVENTED_TENANTS as readonly string[]).includes(name) || INVENTED_COMPANY_TENANT.test(name) || INVENTED_CLIENT_ID.test(name) || name in (rule.real ?? {})
  }
  if (isThirdParty(host)) return true
  // `brightwater.example.role`: a path or a label dressed as an address whose last label is no ending at all, after a reserved one.
  const labels = host.split('.')
  if (labels.length > 2 && (RESERVED_TLDS as readonly string[]).includes(labels[labels.length - 2] ?? '') && !KNOWN_ENDINGS.has(tld)) return true
  if (!options.inAddress && Object.keys(MAIL_PROVIDER_DOMAINS).includes(host)) return true // the provider's own name, never a host under it
  return false
}

/**
 * An email address, written with an at sign or URL-encoded (`%40`). Its domain's last label is letters, which leaves out `name@1.2.3` (a package version); a file name such as `logo@2x.png` is let through below.
 */
const EMAIL = /(?<![A-Za-z0-9._%+=-])[A-Za-z0-9][A-Za-z0-9._%+=-]*(?:@|%40)((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![A-Za-z0-9-])/g
const FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'css', 'js', 'ts', 'tsx', 'json', 'md', 'html', 'txt', 'map', 'mjs'])

/**
 * How a dotted word becomes a host. Any dotted word written after `://` is a host, whatever its ending. Elsewhere its last label must be a top-level domain in lower case (or all upper), and how sure that makes it
 * depends on the label, because most endings are also property names or file extensions (`row.id`, `this.app`, `README.md`):
 *
 *  - `HOST_TLDS`: the endings that are hardly ever a property or a file: a host wherever it is written.
 *  - `CODE_LIKE_TLDS`: the other generic endings and every country ending, each also a property or a word in code (`app`, `dev`, `io`, `co`, `ca`, `online`): a host in a string, a comment, Markdown or any data file,
 *    or straight after a key that names a host (`host:`, `url =`); not in bare code, where a dotted word is a property.
 *  - `WORD_LIKE_TLDS`: endings that are ordinary words almost anywhere (`id`, `in`, `is`, `it`, `me`, `info`, `page`): a host only when the name before the ending is three letters or more and the name is the whole of
 *    a quoted string (or its start, before a slash), or after `://`.
 *  - `PROPERTY_LIKE_TLDS`: the business endings that are property names on the real tree (`site`, `live`, `company`, `email`): the same, and also straight after a key that names a host (`host:`, `url =`, "their site is").
 *
 * A name in camel case inside a string of a code file, starting in lower case, is a property path (`formsService.runBy.site`), not a host; in prose, a comment, Markdown or JSX text it is read like any other.
 *
 * Any other ending (a file extension such as `ts`, `md`, `json`, `sh`, `py`) is not a host unless it follows `://`. A real domain under an ending in no list is therefore missed unless it is a URL.
 */
export const HOST_TLDS = new Set('com org net edu gov mil biz xyz'.split(' '))
export const COUNTRY_TLDS = new Set(
  'ca uk de fr au nz jp cn ru br mx es nl se ch eu ie pt kr za sg hk tw dk fi cz gr il ar cl pe ve ro hu ua tr th vn ph ng ke ae sa qa eg ma pk bd lk np lt lv si sk bg hr'.split(' '),
)
export const CODE_LIKE_TLDS = new Set(
  (
    'app dev io co ai us cloud tv ly gg fm la vc online tech pro mobi agency ' +
    // The endings of the businesses the space serves (a contractor, a clinic, a firm), which are not property names on the real tree. Left out because they are: site, live, company, email, directory, events and
    // video (`Bootstrap.site`, `push.live`, `Me.company`, `userinfo.email`, `calendar.events`), and the plain words store, group, team, design, media, network, tools, works, news, blog, press and photo; those are
    // word-like below.
    'construction plumbing services law legal dental health care clinic medical studio shop solutions consulting business photography marketing restaurant cafe pizza salon beauty fitness yoga church realty ' +
    'properties homes lawyer attorney accountant tax finance financial insurance bank capital ventures partners digital systems technology software guru ninja expert contractors builders roofing electric ' +
    'energy solar auto cars repair cleaning landscaping garden pet vet hotel travel tours wedding gallery'
  ).split(' '),
)
for (const ending of COUNTRY_TLDS) CODE_LIKE_TLDS.add(ending)
export const WORD_LIKE_TLDS = new Set('id in is it to do my no at as by be am ms nu pm me info page ws im'.split(' '))
export const PROPERTY_LIKE_TLDS = new Set('site live company email directory events video store group team design media network tools works news blog press photo'.split(' '))
const KNOWN_ENDINGS = new Set([...HOST_TLDS, ...CODE_LIKE_TLDS, ...WORD_LIKE_TLDS, ...PROPERTY_LIKE_TLDS])
/** The endings a real business host has, for telling a real name from one dressed in a reserved ending: the generic ones and the country ones. */
const REAL_ENDINGS = new Set([...HOST_TLDS, ...COUNTRY_TLDS, 'io', 'co'])

/** A key that says what follows is a host: `host: portal.example.com`, `url = "..."`, "their site is ...". */
const HOST_KEY = /\b(?:host|hostname|domain|url|origin|endpoint|site|website|link|portal)\s*(?:[:=]|\b(?:is|at)\b(?:\s+at\b)?)\s*["'`]?$/i

const DOTTED_WORD = /(?<![A-Za-z0-9_%-])(?<![A-Za-z0-9_]\.)((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+([A-Za-z]{2,24}))(?![A-Za-z0-9_-])/g

/** What a line is in: its file's kind and the scanner's mask of each character (code, string, comment). */
type LineContext = { kind: FileKind; mask: Uint8Array }

/** Whether the character at `index` is where a name is read as written: a string or a comment in code, Markdown outside a fence, and anywhere in a data or script file. */
const inProse = (context: LineContext, index: number): boolean => (context.kind === 'code' || context.kind === 'markdown' ? context.mask[index] !== CODE : true)

const isHost = (host: string, tld: string, line: string, start: number, context: LineContext): boolean => {
  if (line.slice(start - 3, start) === '://') return true
  if (/^[([]/.test(line.slice(start + host.length))) return false // a call: `res.json()` or `list.in(`
  if (CODE_ROOTS.has((host.split('.')[0] ?? '').toLowerCase())) return false
  if (tld !== tld.toLowerCase() && tld !== tld.toUpperCase()) return false // `navigator.onLine` is a property
  const ending = tld.toLowerCase()
  if ((RESERVED_TLDS as readonly string[]).includes(ending)) return true // a reserved ending is safe unless a real host sits in front of it; `domainAllowed` says
  if (HOST_TLDS.has(ending)) return true
  if (context.kind === 'code' && context.mask[start] === STRING && /^[a-z]/.test(host) && /[a-z][A-Z]/.test(host)) return false // `formsService.runBy.site`: a property path in a string of code
  if (CODE_LIKE_TLDS.has(ending)) return inProse(context, start) || HOST_KEY.test(line.slice(0, start))
  const labels = host.split('.')
  const named = (labels[labels.length - 2] ?? '').length >= 3 // `o.company` is a property; the name just before the ending is what must be a name
  const wholeQuoted = named && /["']/.test(line[start - 1] ?? '') && /["'/?#]/.test(line[start + host.length] ?? '')
  if (WORD_LIKE_TLDS.has(ending)) return wholeQuoted
  if (PROPERTY_LIKE_TLDS.has(ending)) return wholeQuoted || (named && HOST_KEY.test(line.slice(0, start)))
  return false
}

/**
 * Hosts allowed only in front of one path, because the code must recognise that address and the host's other pages are anyone's: Google Calendar gives every event a link under its `calendar` path on Google's
 * main web host, while a place's page on the same host names a business.
 */
export const HOST_PATHS = ['www.google.com/calendar/'] as const

/** Where a path on GitHub names an owner: `github.com/<owner>/<repo>`. */
const GITHUB_PATH = /(?<![A-Za-z0-9_-])(?:raw\.)?github(?:usercontent)?\.com\/([A-Za-z0-9_.-]+)(?:\/([A-Za-z0-9_.-]+))?/gi

/** Whether the owner and repository in a GitHub path are the author's own repositories or a listed organisation's. */
const githubPathAllowed = (owner: string, repository: string | undefined): boolean => {
  if (owner.toLowerCase() in GITHUB_OWNERS) return true
  const named = `github.com/${owner}/${(repository ?? '').replace(/\.git$/, '')}`.toLowerCase()
  return AUTHOR_REPOSITORIES.some((own) => own.toLowerCase() === named)
}

/** A dotted word inside the name of an address (after `=`, before `_`, between `+` and `.`): the boundary is any mark but a letter, a digit or a hyphen, and an underscore is one. */
const LOCAL_PART_WORD = /(?<![A-Za-z0-9-])((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+([A-Za-z]{2,24}))(?![A-Za-z0-9-])/g

/**
 * A host written inside the name of an address at an allowed domain: a bounce address that carries the person's own (`bounces+1-ab-dana=example.com@sendgrid.net`), a calendar id that begins with a domain
 * (`example.com_3s7abc@group.calendar.google.com`). The domain after the at sign is safe, what is before it is read like any other text, except that at a reserved domain only a host marked as one is read.
 */
const localPartHosts = (name: string, strict: boolean): string[] => {
  const context: LineContext = { kind: 'other', mask: new Uint8Array(name.length).fill(1) }
  return [...name.matchAll(LOCAL_PART_WORD)].flatMap((match) => {
    const at = match.index ?? 0
    // At a reserved domain a dotted name is a person (`dana.smith@mail.example`, `dana.dental@mail.example`); a host there must end in a generic ending (a link whose user part is a bank's name, the userinfo trick)
    // or be marked as a host, after `=` or before `_`.
    if (strict && name[at - 1] !== '=' && name[at + (match[1]?.length ?? 0)] !== '_' && !HOST_TLDS.has((match[2] ?? '').toLowerCase())) return []
    return match[1] && match[2] && isHost(match[1], match[2], name, at, context) && !domainAllowed(match[1], { inAddress: false }) ? [match[1]] : []
  })
}

/** Whether a domain is one of the reserved ones. */
const isReservedDomain = (domain: string): boolean => {
  const host = domain.toLowerCase()
  return (RESERVED_TLDS as readonly string[]).includes(host.slice(host.lastIndexOf('.') + 1)) || RESERVED_DOMAINS.some((reserved) => endsWithDomain(host, reserved))
}

const addressHits = (line: string, context: LineContext): { kind: 'address'; detail: string }[] => {
  const found: { kind: 'address'; detail: string }[] = []
  // Addresses first; their text is then blanked (to the same length, so positions still line up) so a domain is not also reported as a host.
  const withoutAddresses = line.replace(EMAIL, (match, domain: string) => {
    const extension = domain.slice(domain.lastIndexOf('.') + 1).toLowerCase()
    if (!FILE_EXTENSIONS.has(extension)) {
      // An address is reported without what `=` puts in front of it (`?key=name@host`, `authuser=name@host`).
      const name = match.slice(0, match.length - domain.length - (match.endsWith(`%40${domain}`) ? 3 : 1))
      if (isPlaceholderMailbox(name.slice(name.lastIndexOf('=') + 1), domain)) return ' '.repeat(match.length)
      if (!domainAllowed(domain, { inAddress: true })) found.push({ kind: 'address', detail: `address ${match.slice(match.lastIndexOf('=') + 1).replace('%40', '@')}` })
      else {
        for (const host of localPartHosts(name, isReservedDomain(domain))) found.push({ kind: 'address', detail: `host ${host} in the name of ${match.replace('%40', '@')}` })
      }
    }
    return ' '.repeat(match.length)
  })
  for (const match of withoutAddresses.matchAll(DOTTED_WORD)) {
    const host = match[1]
    const tld = match[2]
    if (!host || !tld) continue
    const from = withoutAddresses.slice(match.index ?? 0).toLowerCase()
    if (HOST_PATHS.some((allowed) => from.startsWith(allowed))) continue
    if (isHost(host, tld, withoutAddresses, match.index ?? 0, context) && !domainAllowed(host, { inAddress: false })) found.push({ kind: 'address', detail: `host ${host}` })
  }
  for (const match of withoutAddresses.matchAll(GITHUB_PATH)) {
    const owner = match[1] ?? ''
    if (!githubPathAllowed(owner, match[2])) found.push({ kind: 'address', detail: `github path ${match[0].replace(/^raw\./i, '')}` })
  }
  return found
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Hex ids
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const HEX_ID = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{32}(?![0-9A-Fa-f])/g

/** Invented: listed, one block of up to sixteen characters repeated to fill the 32 (`0000…`, `1212…`, `deadbeef` four times), or zeros with a short number at the end (`000…00a001`). */
export const isInventedHexId = (hex: string): boolean => (INVENTED_HEX_IDS as readonly string[]).includes(hex.toLowerCase()) || /^(.{1,16})\1+$/.test(hex) || /^0{24}[0-9a-f]{8}$/i.test(hex)

const hexHits = (line: string, path: string): { kind: 'hex-id'; detail: string }[] => {
  if (HASH_FILES.test(path)) return []
  return [...line.matchAll(HEX_ID)].filter((match) => !isInventedHexId(match[0])).map((match) => ({ kind: 'hex-id' as const, detail: `id ${match[0]}` }))
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * A phone number written the ways people write one: `(415) 555-0123`, `415-555-0123`, `415.555.0123`, `415 555 0123`, `+1 415 555 0123`, `+14155550123`, an international number (a plus, a country code and groups of digits), anything after
 * `tel:` or `sms:`, and ten bare digits on a line that talks about a phone. A bare run of digits elsewhere is not one (an id, a timestamp: a United States number never begins with 0 or 1, which epoch seconds do),
 * and neither is a table of figures or path data, so numbers with only spaces are skipped on a line that is SVG path data.
 */
const PHONE_PATTERNS: { pattern: RegExp; /** only on a line that talks about a phone */ needsPhoneWord?: boolean; /** not on a line of path data */ notPathData?: boolean; /** at least this many digits */ minDigits?: number }[] = [
  { pattern: /(?<![\w.+-])(?:\+?1[ .-])?\(\d{3}\)\s?\d{3}[-. ]\d{4}(?![\w-])/g },
  { pattern: /(?<![\w.+-])(?:\+?1[ .-])?\d{3}[-.]\d{3}[-.]\d{4}(?![\w-])/g },
  { pattern: /(?<![\w.])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?![\w-])/g },
  { pattern: /(?<![\w.+-])(?:\+?1 )?[2-9]\d{2} \d{3} \d{4}(?![\w-])/g, notPathData: true },
  { pattern: /\b(?:tel|sms|callto|facetime):\+?[\d\s().-]{7,24}\d/gi, minDigits: 7 },
  { pattern: /(?<![\w.+-])\+?1?[2-9]\d{2}[2-9]\d{6}(?![\w-])/g, needsPhoneWord: true },
]
const PHONE_WORD = /\b(?:phone|tel|telephone|sms|mobile|cell|fax|dial|call(?:s|ing|er)?)\b/i
const PATH_DATA = /<path\b|\bd=["'][MmLlCcHhVvZz]/

/**
 * Numbers that are nobody's although they are not reserved for fiction, which the phone's tests need written out: one valid United States number beside a premium exchange (the test of where premium ends), and a
 * foreign number in digits that count up. Digits only, with the country code.
 */
export const INVENTED_PHONES = ['16269771234', '525512345678'] as const

/**
 * True for a number no person can hold. In the United States: any area code with the 555 exchange and a line of 0100 to 0199 (reserved for fiction); the area code 555, which is not assigned; an exchange that
 * begins with 0 or 1, which no number has; an exchange that is a service code (211 to 911) or the premium exchange 976, which is a service's and never a subscriber's. In the United Kingdom: London's
 * 020 7946 0000 to 0999, reserved for drama. And the listed invented ones.
 */
export const isReservedPhone = (written: string): boolean => {
  const digits = written.replace(/\D/g, '')
  if (/^44207946(?:0\d{3,4})$/.test(digits)) return true
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if ((INVENTED_PHONES as readonly string[]).includes(digits) || (INVENTED_PHONES as readonly string[]).includes(`1${national}`)) return true
  if (national.length !== 10) return false
  const area = national.slice(0, 3)
  const exchange = national.slice(3, 6)
  return (exchange === '555' && national.slice(6, 8) === '01') || area === '555' || /^[01]/.test(exchange) || /^[2-9]11$/.test(exchange) || exchange === '976'
}

const phoneHits = (line: string, kind: FileKind): { kind: 'phone'; detail: string }[] => {
  const found = new Map<string, { kind: 'phone'; detail: string }>()
  const pathData = PATH_DATA.test(line) || (kind === 'html' && /\bd=/.test(line))
  const phoneWord = PHONE_WORD.test(line)
  let rest = line
  for (const { pattern, needsPhoneWord, notPathData, minDigits } of PHONE_PATTERNS) {
    if ((needsPhoneWord && !phoneWord) || (notPathData && pathData)) continue
    rest = rest.replace(pattern, (match) => {
      const digits = match.replace(/\D/g, '')
      const shortest = minDigits ?? 10
      if (digits.length >= shortest && digits.length <= 15 && !isReservedPhone(match.replace(/^[a-z]+:/i, ''))) found.set(match, { kind: 'phone', detail: `phone ${match.trim()}` })
      return ' '.repeat(match.length)
    })
  }
  return [...found.values()]
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// References to private records
// ---------------------------------------------------------------------------------------------------------------------------------------------------

type RecordPattern = { label: string; pattern: RegExp }

/**
 * The files whose subject is where a project that pulls the space keeps an install: the manifest of starting files, the starting files themselves, the install guide and the test of the starting files. The
 * deploy tool keeps every project's instances under one folder name, so these say it; anywhere else the same path is a pointer at one install's files, which no reader of the public copy can open.
 */
export const PROJECT_LAYOUT_FILES = /^(?:zbc-app\.json$|docs\/install\.md$|starter\/|kit\/test\/starter\.test\.ts$)/
const ENVIRONMENT_PATH = 'private environment path'

const RECORD_PATTERNS: RecordPattern[] = [
  { label: 'private record path', pattern: /\bdocs\/(?:problems|decisions|clients|agents)\//i },
  { label: 'private record path', pattern: /\bdocs\/open-threads\b|\bCHECKPOINT\.md\b/ },
  { label: ENVIRONMENT_PATH, pattern: /\bpackages\/infra\/environments\// },
  { label: 'private package scope', pattern: /@ceo\// },
  // A choice cited by its number ("option", then a number, then "of"; a two-digit option or decision; a numbered slice; a numbered step of a plan) names a record the reader cannot open.
  // A screen's own "Option 2 of 3" is not one.
  { label: 'provenance', pattern: /\boption\s+\d{1,2}\s+(?:of|in)\b(?!\s*\d)/i },
  // A decision of a package's own decision records (an ADR) is a public reference whose number is kept, so "decision 21 of ADR 0001" and "decision 15 of the inbox's ADR" are not provenance.
  { label: 'provenance', pattern: /\bdecision\s+\d{1,2}\s+(?:of|in)\b(?!\s*\d)(?![^.;)]{0,40}\bADRs?\b)/i },
  { label: 'provenance', pattern: /\b(?:option|decision)\s+0\d\b/i },
  { label: 'provenance', pattern: /\bslices?\s+\d{1,2}\b/i },
  // A plan's own numbering of its steps (a capital letter and a number), cited in brackets after a space or as the moment something has been true since or until: the reader has no plan to look it up in.
  // A call written `arm(U2)` has no space before its bracket and is code.
  { label: 'provenance', pattern: /(?<=\s)\([A-Z]\d{1,2}[ab]?(?: review)?\)|\b(?:since|until) [A-Z]\d\b/ },
  { label: 'provenance', pattern: /\bsteps?\s+\d{1,2}\s+(?:of|in)\s+(?:the\s+|an?\s+)?(?:option|problem|decision|plan|slice|spec)\b/i },
]

/** A date in a comment says when the line was written, which is where it came from, not what it means. A date in a string or in code is data, as is one with a time of day, or one quoted as an example. */
const ISO_DATE = /\b20\d\d-[01]\d-[0-3]\d\b/g

const HOME_PATH = /(?<![A-Za-z0-9_.:-])\/(?:Users|home)\/([A-Za-z0-9._-]+)/g
const PROJECTS_PATH = /(?<![A-Za-z0-9_])~\/Projects\//

const recordHits = (line: string, context: LineContext, path: string): { kind: 'record'; detail: string }[] => {
  const found: { kind: 'record'; detail: string }[] = []
  const labelled = new Set<string>() // one finding per label on a line, so a phrase matched by two patterns is reported once
  for (const { label, pattern } of RECORD_PATTERNS) {
    if (label === ENVIRONMENT_PATH && PROJECT_LAYOUT_FILES.test(path)) continue
    const match = labelled.has(label) ? null : pattern.exec(line)
    if (match) {
      labelled.add(label)
      found.push({ kind: 'record', detail: `${label} "${match[0].trim()}"` })
    }
  }
  for (const match of line.matchAll(HOME_PATH)) {
    if (!(GENERIC_HOME_NAMES as readonly string[]).includes((match[1] ?? '').toLowerCase())) found.push({ kind: 'record', detail: `home directory "${match[0]}"` })
  }
  if (PROJECTS_PATH.test(line)) found.push({ kind: 'record', detail: 'home directory (a projects folder)' })
  for (const match of line.matchAll(ISO_DATE)) {
    const at = match.index ?? 0
    if (context.mask[at] !== COMMENT) continue
    if (/["'`]/.test(line[at - 1] ?? '') || /^[T ]\d\d:\d\d/.test(line.slice(at + match[0].length))) continue
    found.push({ kind: 'record', detail: `provenance date "${match[0]}"` })
    break
  }
  return found
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * One file: every line that holds an address or host, a hex id, a phone number or a reference to a private record that is not allowed. A line is one hit per kind, its detail naming each thing found,
 * so a line with three addresses is one hit and the report counts lines.
 */
export const checkPublic = (file: SourceFile): Hit[] => {
  if (EXEMPT_FILES.test(file.path)) return []
  const hits: Hit[] = []
  const { kind, mask } = classify(file.path, file.text)
  let offset = 0
  for (const [index, raw] of file.text.split('\n').entries()) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const context: LineContext = { kind, mask: mask.subarray(offset, offset + text.length) }
    offset += raw.length + 1
    if (text.length === 0) continue
    const byKind = new Map<string, string[]>()
    for (const found of [...addressHits(text, context), ...hexHits(text, file.path), ...phoneHits(text, kind), ...recordHits(text, context, file.path)]) {
      const details = byKind.get(found.kind) ?? []
      if (!details.includes(found.detail)) details.push(found.detail)
      byKind.set(found.kind, details)
    }
    for (const [hitKind, details] of byKind) hits.push({ path: file.path, line: index + 1, kind: hitKind, detail: details.join(', '), text })
  }
  return hits
}

/** Many files; what the later failing test calls over the folder and expects to be empty. */
export const checkPublicFiles = (files: SourceFile[]): Hit[] => files.flatMap(checkPublic)
