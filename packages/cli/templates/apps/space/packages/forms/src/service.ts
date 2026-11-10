/**
 * The names the signing service says about itself: what it is called, who runs it, where its mail comes from and where a person writes about their information. They are the install's (the declaration's
 * `formsService` and `senders`, read by `serviceWordsOf` in src/workspace.ts), never constants here: every sentence a signer, an email, a certificate or a seal carries takes its names from this one shape, so a company
 * that runs Forms under another name, or whose Forms another company runs, changes a declaration and no code. Forms' consent and terms keep their sentences; only these names are the install's.
 *
 * Plain data and plain functions with no import of the Workers runtime or the company layer, so the signer's page (a browser bundle) and the Worker read the same shape.
 */

export interface ServiceRunner {
  /** As a person says it: "Northfield Works". */
  name: string
  /** As the law names it: "Northfield Works LLC". */
  legalName: string
  /** The mailing line the email footer carries after the legal name: "Springfield, Ohio", or none. */
  mailingLine: string
  /** The runner's own domain, bare, which the signer's page links to. */
  site: string
}

export interface ServiceWords {
  /** What the service is called: "Northfield Forms". */
  name: string
  /** The address a person writes to about the service and their information. */
  contact: string
  /** The only address signing mail comes from. The Worker's send binding allows no other. */
  sender: string
  runBy: ServiceRunner
  /**
   * The install's own company, who Claude acts for in a record of a send and in the privacy notice's section on Claude: its name ("Northfield Works") and the name the law knows it by ("Northfield Works LLC"). The company that tells Claude what to do, which
   * is the install's, and is kept apart from `runBy` in the shape: where another company runs the service (none does today), Claude is still the install's company's.
   */
  company: { name: string; legalName: string }
  /** The install's owner as the privacy notice names who tells Claude what to do: the name their mail carries ("Tessa Marlow"). */
  owner: string
  /**
   * Present, and true, only where the install's Forms sends only for its own company (the declaration's `formsService.ownCompanyOnly`): the company is the one sending and the one running the service, so no sentence names a
   * second party. Absent for every install that sends for its clients, so those words, and this shape on the wire, are as they were.
   */
  ownCompanyOnly?: true
}

/** "via <service>": what follows a business's name in the name a signer's mail shows, or nothing where the install's Forms is its own company's. */
export const viaSuffix = (w: Pick<ServiceWords, 'name' | 'ownCompanyOnly'>): string => (w.ownCompanyOnly ? '' : `via ${w.name}`)

/** The reason recorded in every seal, and shown by a PDF reader's signature panel. */
export const sealReason = (w: Pick<ServiceWords, 'name'>): string => `Sealed by ${w.name}`

/** The subject a certificate of completion names for a seal it cannot read (a Worker with none). */
export const sealSubject = (w: Pick<ServiceWords, 'name'>): string => `${w.name} Seal`

/** The name of the seal's root certificate as the seal script makes it (scripts/certs.ts) and as the certificate names it when the seal itself cannot be read. */
export const sealRootName = (w: Pick<ServiceWords, 'name'>): string => `${w.name} Root`

/** The legal name and mailing line as the email footer writes them: "Northfield Works LLC, Springfield, Ohio". */
export const runnerPlace = (w: Pick<ServiceWords, 'runBy'>): string => (w.runBy.mailingLine ? `${w.runBy.legalName}, ${w.runBy.mailingLine}` : w.runBy.legalName)

/**
 * The privacy notice's section on Claude. The company that may let Claude act, and whose owner tells it what to do, is the install's own (`ServiceWords.company`), which is not who runs the service where another company
 * does (none does today).
 */
export const claudeNotice = (w: Pick<ServiceWords, 'company' | 'owner'>): string =>
  `Today Claude has no access to this service. ${w.company.name} may later let Claude send a document, send a reminder, cancel one or correct an email address, only when ${w.owner} tells it to and with each instruction recorded. If it does, Claude would see only a document’s title and status, the names and email addresses of the people on it, the record of its steps (times, IP addresses and device types) and the business’s name and addresses, and the service would refuse it answers, uploaded files, private numbers and finished documents. As a rule ${w.company.name} sets for itself, not a technical guarantee: ${w.company.name} does not let Claude read answers, uploaded files, private numbers or finished signed documents. This notice will be changed before Claude is given any access.`
