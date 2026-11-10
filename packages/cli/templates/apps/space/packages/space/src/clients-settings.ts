// Settings › Clients (the space's ADR 0021): the list of Clients, one Client's page, and the four things the owner does to a Client (New,
// Edit, Archive, Put back).
//
// A Client is the Clients part's (packages/clients), run in this Worker over a store of its own, and the owner's alone to change. What the part does not know is how many people, conversations and open ones the
// inbox holds under each Client, who those people are, and whom it only suggests: those are the inbox's, and a Client's page is the two put together HERE, in the Worker, so the page makes one read and the
// two rules stay with their owners. Each answer is a `ViewAnswer`, the same words every view in Settings uses (views.ts), and each write is one call, never retried.
//
// NOTHING HERE KNOWS A SOURCE. A Client's source (a company's website, say) is the part's generic `source` fields: its name, an address of the Client in its admin, what it last said of the names and the extra
// text fields its sender named. The page shows what is there and never edits it. Those fields are drawn as label and value pairs: the label is the company declaration's for the key (`clientsDoor.fields`), or
// the key made readable, and the one key the inbox suggests by is the declaration's too (`clientsDoor.suggestByAddressKey`). No key is read by name here.

import {
  ANSWER_WITHIN_MS,
  type Client,
  type ClientEdit,
  type ClientFieldDisplay,
  type ClientFieldKind,
  type ClientList,
  type ClientMake,
  type ClientSourceStatus,
  type FormsClientNames,
  type InboxClientContact,
  type InboxClientPage,
  type InboxClients,
  type InboxClientSuggestion,
  type InboxDirectory,
  type SigningSettings,
  type SpaceReply,
  WRITE_WITHIN_MS,
} from '@space/workspace'
import { followLegal, followName } from '@space/clients/src/store'
import { type CopyDifference, copyDifference, namesOf } from './clients-forms'
import { isCount, isList, isRecord, isText } from './guards'
import type { Asking } from './list'
import { notConnected, reach, reachWrite } from './reach'
import { answerOf, isClientPage, isClients, type ViewAnswer } from './views'

const inboxClients = (v: unknown): v is InboxClients => isClients(v)
const inboxClientPage = (v: unknown): v is InboxClientPage => isClientPage(v)

const PART = 'Clients'

// ── What the page is given ────────────────────────────────────────────────────────────────────────────────────────────────

/** One of a source's extra fields as it is drawn: its label, its value and how to read the value. */
export interface ClientFieldValue {
  key: string
  label: string
  value: string
  kind: ClientFieldKind
}

/** A key made readable: `lastSeenAt` is "Last seen at". */
export function humanise(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ').trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * A source's extra fields as label and value pairs: the declared ones that have a value, in the order the declaration lists them, then any other key under its readable name. An empty value is not shown.
 * `listOnly` keeps the ones the declaration says the list shows too, and no undeclared one.
 */
export function fieldValues(extra: Record<string, string>, declared: readonly ClientFieldDisplay[], listOnly = false): ClientFieldValue[] {
  const known = declared.filter((d) => (extra[d.key] ?? '') !== '' && (!listOnly || d.list)).map((d) => ({ key: d.key, label: d.label, value: extra[d.key] as string, kind: d.kind }))
  if (listOnly) return known
  const others = Object.keys(extra)
    .filter((k) => extra[k] !== '' && !declared.some((d) => d.key === k))
    .sort()
    .map((k) => ({ key: k, label: humanise(k), value: extra[k] as string, kind: 'text' as const }))
  return [...known, ...others]
}

/** One Client in the list, with the people the inbox holds under it. */
export interface ClientRow {
  number: number
  name: string
  legalName: string | null
  /** The source that brought it in (a website, say), or null for a Client made in the space. */
  source: string | null
  /** Since when the source says it no longer lists the Client, or null. */
  goneSince: number | null
  archivedAt: number | null
  /** The source's fields the declaration says the list shows (label and value), in its order; none for a Client made in the space. */
  fields: ClientFieldValue[]
  /** Whether the name still follows what the source says (the source renames it; nothing was edited here). False for a Client made in the space. */
  followsSource: boolean
  contacts: number
  conversations: number
  open: number
}

/** A number some person is linked to that the part does not hold: shown by number, as the inbox always has. */
export interface UnlistedRow {
  number: number
  name: string
  contacts: number
  conversations: number
  open: number
}

export interface ClientsScreen {
  /** Whether the inbox could count the people under each Client; false and the counts are zeros, said on the page. */
  peopleCounted: boolean
  peopleError: string | null
  /** When the source was last heard from; null where the install has no source. */
  source: ClientSourceStatus | null
  active: ClientRow[]
  archived: ClientRow[]
  unlisted: UnlistedRow[]
}

/** What a Client's names are against what its source says of them. Null where the Client was made in the space. */
export interface ClientNames {
  /** The name still follows the source's. */
  followsName: boolean
  followsLegalName: boolean
  /** What the source last said, whole. Shown when it differs from the Client's own (an edit here took over). */
  saidName: string
  saidLegalName: string | null
}

/**
 * Whether Forms signs for a Client: its signing settings are a Forms client row carrying the Client's number. `available` is false when Forms could not be asked (the page says so and offers nothing). The row's names are Forms' COPY of the
 * Client's, written by this part (clients-forms.ts), so only its id and reply address are shown, and `copy` when the copy is not the Client's (Forms refuses the Client's name, the Client has no legal name, or the tick has not run yet),
 * with why and what to do.
 */
export interface ClientSigning {
  available: boolean
  settings: { id: string; replyTo: string; copy: CopyDifference | null } | null
}

export interface ClientScreen {
  number: number
  /** The Client as the part holds it, or null for a number the inbox holds people under and the part does not. */
  client: Client | null
  /** The name to show: the Client's, or "Client 7". */
  name: string
  names: ClientNames | null
  directory: InboxDirectory
  peopleCounted: boolean
  peopleError: string | null
  counts: { contacts: number; conversations: number; open: number }
  /** The address of the Client in its source's admin. */
  adminUrl: string | null
  /** Everything the source last said of the Client beyond its names, as label and value pairs. */
  fields: ClientFieldValue[]
  /** Whether Forms is set up to send for this Client, with the way into its signing settings. */
  signing: ClientSigning
  /** What to call the address a person is suggested by (the declared field's label), or null where the install declares none. */
  matchLabel: string | null
  contacts: InboxClientContact[]
  suggestions: InboxClientSuggestion[]
}

// ── The shapes read from the part ────────────────────────────────────────────────────────────────────────────────────────

const textOrNull = (v: unknown): boolean => v === null || isText(v)
const countOrNull = (v: unknown): boolean => v === null || isCount(v)

const isSourcePart = (v: unknown): boolean =>
  v === null ||
  (isRecord(v) &&
    isText(v.source) &&
    isText(v.externalId) &&
    textOrNull(v.url) &&
    isRecord(v.said) &&
    isText(v.said.name) &&
    textOrNull(v.said.legalName) &&
    isRecord(v.extra) &&
    Object.values(v.extra).every(isText) &&
    countOrNull(v.goneSince))

export const isClient = (v: unknown): v is Client =>
  isRecord(v) &&
  isCount(v.number) &&
  isText(v.name) &&
  textOrNull(v.legalName) &&
  isCount(v.createdAt) &&
  isText(v.createdBy) &&
  isCount(v.updatedAt) &&
  isText(v.updatedBy) &&
  countOrNull(v.archivedAt) &&
  textOrNull(v.archivedBy) &&
  isCount(v.revision) &&
  isSourcePart(v.source)

const isStatus = (v: unknown): boolean =>
  v === null || (isRecord(v) && isText(v.name) && countOrNull(v.lastPushAt) && countOrNull(v.lastSyncAt) && countOrNull(v.syncedCount))

const isSigningList = (v: unknown): v is SigningSettings[] => isList(v) && v.every((r) => isRecord(r) && isText(r.id) && isCount(r.number) && isText(r.name) && isText(r.legalName) && isText(r.replyTo))

const isClientList = (v: unknown): v is ClientList => isRecord(v) && isList(v.active) && v.active.every(isClient) && isList(v.archived) && v.archived.every(isClient) && isStatus(v.source)

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const usageOf = (list: InboxClients | null) => new Map((list?.clients ?? []).map((c) => [c.id, c]))

/** Whether the name still follows the source (the part's rule: it does while it equals what the source last said, cut to the longest name). */
const follows = (c: Client): boolean => c.source !== null && c.name === followName(c.source.said.name)

function rowOf(c: Client, usage: Map<number, InboxClients['clients'][number]>, declared: readonly ClientFieldDisplay[]): ClientRow {
  const u = usage.get(c.number)
  return {
    number: c.number,
    name: c.name,
    legalName: c.legalName,
    source: c.source?.source ?? null,
    goneSince: c.source?.goneSince ?? null,
    archivedAt: c.archivedAt,
    fields: fieldValues(c.source?.extra ?? {}, declared, true),
    followsSource: follows(c),
    contacts: u?.contacts ?? 0,
    conversations: u?.conversations ?? 0,
    open: u?.open ?? 0,
  }
}

/** The list: every Client the part holds (active and archived apart), the source's status, and the people the inbox holds under each. */
export async function readClientsScreen(ask: Asking): Promise<ViewAnswer<ClientsScreen>> {
  const { clients, inbox } = ask.apps
  if (!clients) return answerOf(notConnected(PART))
  const a = ask.signedIn
  const ms = ask.answerWithinMs ?? ANSWER_WITHIN_MS
  const [list, counted] = await Promise.all([
    reach(PART, () => clients.clients(a), isClientList, ms),
    inbox ? reach('Email', () => inbox.clients(a), inboxClients, ms) : Promise.resolve(null),
  ])
  if (!list.ok) return answerOf(list)
  const people = counted?.ok ? counted.value : null
  const usage = usageOf(people)
  const declared = ask.install.clientsDoor()?.fields ?? []
  const held = new Set([...list.value.active, ...list.value.archived].map((c) => c.number))
  return {
    result: 'ok',
    value: {
      peopleCounted: people !== null,
      peopleError: people === null ? (counted && !counted.ok ? counted.message : 'Email is not connected to the space.') : people.directory.available ? null : people.directory.error,
      source: list.value.source,
      active: list.value.active.map((c) => rowOf(c, usage, declared)),
      archived: list.value.archived.map((c) => rowOf(c, usage, declared)),
      unlisted: (people?.clients ?? []).filter((c) => !held.has(c.id) && c.contacts > 0).map((c) => ({ number: c.id, name: c.name, contacts: c.contacts, conversations: c.conversations, open: c.open })),
    },
  }
}

/** How Forms' copy of this Client's names differs from the Client's, with Forms' own reason when it refuses them (asked only when they differ), or null when they agree. */
async function copyOf(forms: FormsClientNames, row: SigningSettings, client: Client, ms: number): Promise<CopyDifference | null> {
  if (copyDifference(row, client, null) === null) return null
  const verdict = await reach('Forms', () => forms.check(namesOf(client)), (v): v is null => v === null, ms)
  return copyDifference(row, client, !verdict.ok && verdict.kind === 'refused' ? verdict.message : null)
}

/** One Client's page: the part's Client and the inbox's people under it. A number only the inbox's people hold is a page too, by number. */
export async function readClientScreen(ask: Asking, number: number): Promise<ViewAnswer<ClientScreen>> {
  const { clients, inbox, formsNames } = ask.apps
  if (!clients) return answerOf(notConnected(PART))
  const a = ask.signedIn
  const ms = ask.answerWithinMs ?? ANSWER_WITHIN_MS
  const [part, page, signing] = await Promise.all([
    reach(PART, () => clients.client(a, number), isClient, ms),
    inbox ? reach('Email', () => inbox.client(a, number), inboxClientPage, ms) : Promise.resolve(null),
    formsNames ? reach('Forms', () => formsNames.linked(), isSigningList, ms) : Promise.resolve(null),
  ])
  // A refusal the part does not make about a number it lacks (not-admitted, a fault) is the answer; "no such Client" is a page only if the inbox holds people there.
  if (!part.ok && !(part.kind === 'refused' && part.reason === 'not-found')) return answerOf(part)
  const client = part.ok ? part.value : null
  const people: InboxClientPage | null = page?.ok ? page.value : null
  if (client === null && people === null) return { result: 'refused', reason: 'not-found', message: 'No such Client.' }
  const said = client?.source ?? null
  const signs = signing?.ok ? (signing.value.find((r) => r.number === number) ?? null) : null
  const copy = signs && client && formsNames ? await copyOf(formsNames, signs, client, ms) : null
  const door = ask.install.clientsDoor()
  const declared = door?.fields ?? []
  const matchKey = door?.suggestByAddressKey ?? null
  return {
    result: 'ok',
    value: {
      number,
      client,
      name: client?.name ?? people?.client.name ?? `Client ${number}`,
      names: said === null || client === null ? null : { followsName: client.name === followName(said.said.name), followsLegalName: client.legalName === followLegal(said.said.legalName), saidName: said.said.name, saidLegalName: said.said.legalName },
      directory: people?.directory ?? { available: false, error: page && !page.ok ? page.message : 'Email is not connected to the space.' },
      peopleCounted: people !== null,
      peopleError: people === null ? (page && !page.ok ? page.message : 'Email is not connected to the space.') : null,
      counts: { contacts: people?.client.contacts ?? 0, conversations: people?.client.conversations ?? 0, open: people?.client.open ?? 0 },
      signing: signing?.ok ? { available: true, settings: signs && { id: signs.id, replyTo: signs.replyTo, copy } } : { available: false, settings: null },
      adminUrl: people?.client.adminUrl ?? client?.source?.url ?? null,
      fields: fieldValues(client?.source?.extra ?? {}, declared),
      matchLabel: matchKey === null ? null : (declared.find((d) => d.key === matchKey)?.label ?? humanise(matchKey)),
      contacts: people?.contacts ?? [],
      suggestions: people?.suggestions ?? [],
    },
  }
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

/** The longest body a Client write takes. The part applies its own, much shorter limits to the names. */
const NUMBER = (v: unknown): v is number => isCount(v) && v >= 1

async function change(ask: Asking, call: (clients: NonNullable<Asking['apps']['clients']>) => Promise<SpaceReply<Client>>): Promise<ViewAnswer<Client>> {
  const { clients } = ask.apps
  if (!clients) return { result: 'failed', message: 'Clients is not connected to the space. Nothing was changed.' }
  return answerOf(await reachWrite(PART, () => call(clients), isClient, ask.writeWithinMs ?? WRITE_WITHIN_MS))
}

/** New Client: a name, and a legal name when it has one. */
export async function makeClientView(ask: Asking, body: unknown): Promise<Parsed<ViewAnswer<Client>>> {
  if (!isRecord(body) || !isText(body.name)) return { ok: false, message: 'A new Client needs a name.' }
  if (body.legalName !== undefined && body.legalName !== null && !isText(body.legalName)) return { ok: false, message: 'A legal name is text, or left out.' }
  const make: ClientMake = { name: body.name, ...(body.legalName !== undefined && { legalName: body.legalName as string | null }) }
  return { ok: true, value: await change(ask, (c) => c.makeClient(ask.signedIn, make)) }
}

/**
 * Edit: the Client, the revision the person was shown, and the name or legal name changed. An out-of-date screen is the part's `conflict`.
 *
 * FORMS KEEPS A COPY of the names of a Client it signs for, and this is where it is written (clients-forms.ts): in the same request as the edit, once the part has stored it. Before the part is asked, Forms is asked whether it can keep the
 * names the Client would have (it refuses a few characters in the name that a signer sees as the sender of mail), so a Client Forms signs for is never saved under a name Forms would have to refuse; the sentence says so and nothing is changed.
 * A copy that could not be written is not the edit's failure: the edit is stored, and the tick of the Worker's scheduled handler puts the copy right within five minutes.
 */
export async function editClientView(ask: Asking, body: unknown): Promise<Parsed<ViewAnswer<Client>>> {
  if (!isRecord(body) || !NUMBER(body.number)) return { ok: false, message: 'Say which Client: number.' }
  if (!isCount(body.revision)) return { ok: false, message: 'Say which revision of the Client you were shown (revision).' }
  if (body.name !== undefined && !isText(body.name)) return { ok: false, message: 'The name is text.' }
  if (body.legalName !== undefined && body.legalName !== null && !isText(body.legalName)) return { ok: false, message: 'The legal name is text, or empty.' }
  if (body.name === undefined && body.legalName === undefined) return { ok: false, message: 'Change the name or the legal name.' }
  const edit: ClientEdit = { ...(body.name !== undefined && { name: body.name as string }), ...(body.legalName !== undefined && { legalName: body.legalName as string | null }) }
  const { number, revision } = body
  // Only a Client Forms signs for has a copy of its names there; one it does not is edited without a word to Forms. (Asked once, before the edit: a row linked in between is put right by the tick.)
  const forms = (await signsFor(ask.apps.formsNames, number)) ? ask.apps.formsNames : undefined
  const cannot = forms ? await namesFormsCannotKeep(ask, forms, number, edit) : null
  if (cannot) return { ok: true, value: { result: 'refused', reason: 'bad-request', message: cannot } }
  const answer = await change(ask, (c) => c.editClient(ask.signedIn, number, revision, edit))
  if (answer.result === 'ok' && forms) await copyNamesToForms(ask, forms, answer.value)
  return { ok: true, value: answer }
}

/** Whether Forms has signing settings linked to this Client. False when Forms is not connected or cannot be asked: the edit then goes ahead and the tick puts any copy right. */
async function signsFor(forms: FormsClientNames | undefined, number: number): Promise<boolean> {
  if (!forms) return false
  try {
    const linked = await forms.linked()
    return linked.ok && linked.value.some((r) => r.number === number)
  } catch (e) {
    console.warn('clients: Forms could not be asked which Clients it signs for', e)
    return false
  }
}

/** The sentence when Forms could not keep the names the edit would give this Client (it signs for it), or null. */
async function namesFormsCannotKeep(ask: Asking, forms: FormsClientNames, number: number, edit: ClientEdit): Promise<string | null> {
  try {
    const current = ask.apps.clients ? await ask.apps.clients.client(ask.signedIn, number) : null
    if (!current?.ok) return null
    const next = { name: edit.name ?? current.value.name, legalName: edit.legalName === undefined ? current.value.legalName : edit.legalName?.trim() || null }
    // A document Forms signs names the Client's legal name, and Forms would go on signing under the old one while the Client showed none: clearing it is refused while signing is set up.
    if (next.legalName === null && current.value.legalName !== null) return `Forms signs for this Client, and a document it signs names the Client's legal name, so the legal name cannot be cleared. Change it to the right one instead. Nothing was changed.`
    const verdict = await forms.check({ name: next.name.trim(), legalName: next.legalName })
    return verdict.ok ? null : `${verdict.message} Forms signs for this Client, so its name has to be one Forms can send mail under. Nothing was changed.`
  } catch (e) {
    console.warn('clients: Forms could not be asked about a name', e)
    return null
  }
}

/** Write Forms' copy of an edited Client's names, as the person who edited it. A failure is said in the log and left to the tick. */
async function copyNamesToForms(ask: Asking, forms: FormsClientNames, client: Client): Promise<void> {
  try {
    const wrote = await forms.setNames(client.number, namesOf(client), ask.signedIn.person.address)
    if (!wrote.ok) console.warn(`clients: Forms' copy of the names of Client ${client.number} was not written (the tick will put it right): ${wrote.message}`)
  } catch (e) {
    console.warn(`clients: Forms' copy of the names of Client ${client.number} was not written (the tick will put it right)`, e)
  }
}

/** Archive or put back one Client, by its number. */
export async function archiveClientView(ask: Asking, body: unknown, back: boolean): Promise<Parsed<ViewAnswer<Client>>> {
  if (!isRecord(body) || !NUMBER(body.number)) return { ok: false, message: 'Say which Client: number.' }
  const number = body.number
  return { ok: true, value: await change(ask, (c) => (back ? c.putBackClient(ask.signedIn, number) : c.archiveClient(ask.signedIn, number))) }
}
