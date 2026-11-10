// The Clients part and Forms' copy of a Client's names (the space's ADR 0021).
//
// A Forms client row is a Client's signing settings. Forms keeps a COPY of the Client's name and legal name on the row, because signing emails, signers' pages and sealed certificates read them there. THE CLIENTS PART IS THE ONE WRITER OF THAT COPY, in
// two places and nowhere else: an edit in Settings writes it in the same request (clients-settings.ts), and the five-minute tick puts right any copy that differs (this file, run by the Worker's scheduled handler). The tick is what catches a rename a
// source pushed in through the Clients door, which changes the Client alone, a write Forms was unreachable for, and a row linked while a name was being edited.
//
// Forms is asked through `FormsClientNames`, in-process: list the rows linked to a Client, say whether a name can be kept, write one row's copy. Nothing here knows how Forms stores a row.

import type { Client, ClientsForInbox, FormsClientNames, SigningSettings } from '@space/workspace'

/** Who the audit rows of the tick are written as. */
export const REPAIR_ACTOR = 'clients:repair'

export interface RepairResult {
  /** The linked rows looked at. */
  checked: number
  /** Rows whose copy differed and was rewritten. */
  fixed: number
  /** Rows whose copy differed and could not be rewritten (Forms refused the name, or could not be reached); the next tick tries again. */
  failed: number
}

/** The names Forms should hold for a Client: its name, and its legal name when it has one (Forms always has a legal name, so a Client with none leaves Forms' as it is). */
export const namesOf = (c: Pick<Client, 'name' | 'legalName'>): { name: string; legalName: string | null } => ({ name: c.name, legalName: c.legalName })

/** Whether the tick can put the copy right by writing: the name differs, or the legal name does and the Client has one. A Client with no legal name leaves Forms' as it is. */
export const copyNeedsWriting = (row: Pick<SigningSettings, 'name' | 'legalName'>, wanted: { name: string; legalName: string | null }): boolean =>
  row.name !== wanted.name || (wanted.legalName !== null && row.legalName !== wanted.legalName)

/**
 * One pass: every Forms row linked to a Client has its copy of the names compared with the Client's, and rewritten where it differs. Archived Clients are included (their documents go on). A row whose Client the part does not hold is left
 * alone. Asks Forms for nothing but the linked rows and writes only the rows that differ, so a pass with nothing to do changes nothing and writes no audit row.
 */
export async function repairFormsNames(forms: FormsClientNames | undefined, clients: ClientsForInbox | undefined): Promise<RepairResult> {
  const out: RepairResult = { checked: 0, fixed: 0, failed: 0 }
  if (!forms || !clients) return out
  const [held, linked] = await Promise.all([clients.list(), forms.linked()])
  if (!held.ok || !linked.ok) return out
  const byNumber = new Map(held.value.map((c) => [c.number, c]))
  for (const row of linked.value) {
    const client = byNumber.get(row.number)
    if (!client) continue
    out.checked++
    const wanted = namesOf(client)
    if (!copyNeedsWriting(row, wanted)) continue
    const wrote = await forms.setNames(row.number, wanted, REPAIR_ACTOR)
    if (wrote.ok) out.fixed++
    else {
      out.failed++
      console.warn(`clients: Forms' copy of the names of Client ${row.number} was not put right: ${wrote.message}`)
    }
  }
  return out
}

// ── What the Client's page says when Forms' copy is not the Client's ──────────────────────────────────────────────────────────

/** How Forms' copy of a Client's names differs from the Client's, and what to do, in sentences a person reading the Client's page can act on. */
export interface CopyDifference {
  /** What Forms signs under now. */
  formsName: string
  formsLegalName: string
  /** What the Client has. */
  clientName: string
  clientLegalName: string | null
  /** Why the copy is not the Client's. */
  why: string
  /** What to do about it. */
  todo: string
}

/**
 * How a Forms row's copy differs from its Client's, or null when it does not. `refusal` is Forms' own sentence for why it cannot keep the Client's names (`FormsClientNames.check`), or null when it can (or was not asked). Three cases: Forms
 * refuses the Client's names (nothing the tick does will change that, and a source's push can bring such a name in), the Client has no legal name where Forms has one (Forms keeps it; clearing it is not the tick's to do), and a copy the
 * tick has not written yet.
 */
export function copyDifference(row: Pick<SigningSettings, 'name' | 'legalName'>, client: Pick<Client, 'name' | 'legalName'>, refusal: string | null): CopyDifference | null {
  const wanted = namesOf(client)
  const needsWriting = copyNeedsWriting(row, wanted)
  const dropped = wanted.legalName === null
  if (!needsWriting && !dropped) return null
  const base = { formsName: row.name, formsLegalName: row.legalName, clientName: client.name, clientLegalName: client.legalName }
  if (refusal !== null) {
    return {
      ...base,
      why: `${refusal} Forms cannot keep this Client's names, so it still signs under the ones it has.`,
      todo: "Change the name on this page to one Forms can send mail under (Edit). The edit stands even where the Client's source says otherwise.",
    }
  }
  if (!needsWriting) {
    return {
      ...base,
      why: 'This Client has no legal name now (it was cleared, or its source stopped sending one), and Forms keeps the one it had.',
      todo: `Give the Client a legal name on this page (Edit). Until then Forms signs under “${row.legalName}”.`,
    }
  }
  return { ...base, why: "Forms has not copied the Client's names yet.", todo: 'Nothing to do: Forms copies them within five minutes.' }
}
