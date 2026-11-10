// A stand-in for what the Clients part asks of Forms (`FormsClientNames`; packages/forms/src/client-names.ts): which Clients have signing settings, whether a name can be kept, and the one writing of Forms' copy of a Client's names.
// `bun test` asks it instead of Forms' database, and a local page shows it with fixture data (`SPACE_FIXTURES`, src/app.ts) so a Client's page can show its Signing part. With `formsAt` (a real forms running beside the preview, e2e/stack.ts)
// `linked` reads the real Forms' rows, so the page and the end-to-end suite see the same signing settings; the writes stay the stand-in's.
//
// Every call is recorded, and a script can make the next one fail, so a test can see what was and was not sent.

import { answered, failed, refused, type FormsClientNames, type SigningNames, type SigningSettings, type SpaceReply } from '@space/workspace'

export interface StandInFormsNames {
  /** Every call, by method and its arguments. */
  calls: { method: string; args: unknown[] }[]
  /** The rows linked to a Client, with Forms' copy of their names. */
  rows: SigningSettings[]
  /** What the next call does instead of the normal thing: `throw` (Forms cannot be reached), `hang` (never answers), `broken` (a fault). */
  script: ('throw' | 'hang' | 'broken')[]
  methods: FormsClientNames
}

/** Forms' own rule for a name a signer sees as the sender of mail (packages/forms/src/clients.ts); the stand-in keeps the same characters out so a screen can be shown refusing one. */
const SENDER_NAME = /^[^<>"\\,;:@()\u0000-\u001f\u007f-\u009f]+$/

export function standInFormsNames(rows: SigningSettings[], options: { formsAt?: string } = {}): StandInFormsNames {
  const state: StandInFormsNames = { calls: [], rows: rows.map((r) => ({ ...r })), script: [], methods: undefined as never }

  async function enter<T>(method: string, args: unknown[]): Promise<SpaceReply<T> | null> {
    state.calls.push({ method, args })
    const step = state.script.shift()
    if (step === 'throw') throw new Error('stand-in Forms lost the connection')
    if (step === 'hang') return new Promise(() => undefined)
    if (step === 'broken') return failed('Forms could not answer that.')
    return null
  }
  const problem = (names: SigningNames): string | null => {
    const name = names.name.trim()
    if (name === '' || Array.from(name).length > 80) return 'The name is required and at most 80 characters.'
    if (!SENDER_NAME.test(name)) return 'The name may not contain < > " \\ , ; : @ ( ) because it is shown as the sender of signing mail'
    return null
  }

  state.methods = {
    async linked() {
      const early = await enter<SigningSettings[]>('linked', [])
      if (early) return early
      if (options.formsAt) {
        const res = await fetch(`${options.formsAt}/admin/api/clients`, { headers: { accept: 'application/json' } })
        if (!res.ok) return failed('The local forms did not answer.')
        const listed = (await res.json()) as { id: string; client_number: number | null; display_name: string; legal_name: string; reply_to: string }[]
        return answered(listed.filter((r) => r.client_number !== null).map((r) => ({ id: r.id, number: r.client_number as number, name: r.display_name, legalName: r.legal_name, replyTo: r.reply_to })))
      }
      return answered(state.rows.map((r) => ({ ...r })))
    },
    async check(names) {
      const early = await enter<null>('check', [names])
      if (early) return early
      const why = problem(names)
      return why === null ? answered(null) : refused('bad-request', why)
    },
    async setNames(number, names, actor) {
      const early = await enter<{ changed: boolean }>('setNames', [number, names, actor])
      if (early) return early
      const why = problem(names)
      if (why !== null) return refused('bad-request', why)
      const row = state.rows.find((r) => r.number === number)
      if (!row) return refused('not-found', 'No Forms client is linked to that Client.')
      const changed = row.name !== names.name || (names.legalName !== null && row.legalName !== names.legalName)
      row.name = names.name
      if (names.legalName !== null) row.legalName = names.legalName
      return answered({ changed })
    },
  }
  return state
}
