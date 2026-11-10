// The Clients part is the one writer of Forms' copy of a Client's names. Settings writes it in the same request as an edit (test/clients-settings.test.ts); this is the other writer, the
// five-minute tick (`repairFormsNames`, run by the Worker's scheduled handler), over the REAL Clients part and a stand-in for Forms' rows: a rename a source pushed in, a write Forms was down for, and everything that must be left alone.
import { describe, expect, test } from 'bun:test'
import { ACME, BOLT, TestClients } from '@space/inbox/test-support/clients-part'
import { REPAIR_ACTOR, repairFormsNames } from '../src/clients-forms'
import { standInFormsNames } from '../src/stand-in-forms-names'

const row = (number: number, name: string, legalName: string) => ({ id: `row-${number}`, number, name, legalName, replyTo: `office@c${number}.example` })

describe('the tick that puts Forms’ copy of the names right', () => {
  test('a name the Client has and the copy does not is written, as the repair, and a pass with nothing to do writes nothing', async () => {
    const part = new TestClients([ACME, BOLT])
    const forms = standInFormsNames([row(1, 'Acme Legal', 'Acme Legal LLP'), row(2, 'Bolt Machines', 'Bolt Machines Inc.')])
    expect(await repairFormsNames(forms.methods, part)).toEqual({ checked: 2, fixed: 0, failed: 0 })
    expect(forms.calls.filter((c) => c.method === 'setNames')).toEqual([])
    // The source renames Acme and it follows (the Clients door changes the Client alone).
    part.push({ ...ACME, name: 'Acme Law Offices' })
    expect(await repairFormsNames(forms.methods, part)).toEqual({ checked: 2, fixed: 1, failed: 0 })
    expect(forms.rows[0]).toMatchObject({ name: 'Acme Law Offices', legalName: 'Acme Legal LLP' })
    expect(forms.calls.filter((c) => c.method === 'setNames')).toEqual([{ method: 'setNames', args: [1, { name: 'Acme Law Offices', legalName: 'Acme Legal LLP' }, REPAIR_ACTOR] }])
    // Again: nothing differs, so nothing is written.
    expect(await repairFormsNames(forms.methods, part)).toEqual({ checked: 2, fixed: 0, failed: 0 })
    expect(forms.calls.filter((c) => c.method === 'setNames')).toHaveLength(1)
  })

  test('a Client renamed here is put right too, an archived one included (its documents go on), and a Client with no legal name leaves Forms’ as it is', async () => {
    const part = new TestClients([ACME, BOLT])
    const forms = standInFormsNames([row(1, 'Acme Legal', 'Acme Legal LLP'), row(2, 'Bolt Machines', 'Bolt Machines Inc.')])
    part.rename(2, 'Bolt Co')
    part.archive(2)
    expect(await repairFormsNames(forms.methods, part)).toEqual({ checked: 2, fixed: 1, failed: 0 })
    expect(forms.rows[1]).toMatchObject({ name: 'Bolt Co', legalName: 'Bolt Machines Inc.' })
  })

  test('a row whose Client the part does not hold is left alone; rows not linked are not Forms’ to list here', async () => {
    const part = new TestClients([ACME])
    const forms = standInFormsNames([row(1, 'Acme Legal', 'Acme Legal LLP'), row(77, 'Stray', 'Stray Inc')])
    expect(await repairFormsNames(forms.methods, part)).toEqual({ checked: 1, fixed: 0, failed: 0 })
    expect(forms.rows[1]).toMatchObject({ name: 'Stray' })
  })

  test('a name Forms refuses is counted as not put right and left for the next tick; one row failing does not stop the others', async () => {
    const part = new TestClients([ACME, BOLT])
    const forms = standInFormsNames([row(1, 'Acme Legal', 'Acme Legal LLP'), row(2, 'Bolt Machines', 'Bolt Machines Inc.')])
    part.rename(1, 'Acme, Smith & Co')
    part.rename(2, 'Bolt Co')
    expect(await repairFormsNames(forms.methods, part)).toEqual({ checked: 2, fixed: 1, failed: 1 })
    expect(forms.rows.map((r) => r.name)).toEqual(['Acme Legal', 'Bolt Co'])
  })

  test('with either side unreachable or absent a pass does nothing and does not throw', async () => {
    const part = new TestClients([ACME])
    const forms = standInFormsNames([row(1, 'Acme Legal', 'Acme Legal LLP')])
    part.rename(1, 'Acme Law')
    expect(await repairFormsNames(undefined, part)).toEqual({ checked: 0, fixed: 0, failed: 0 })
    expect(await repairFormsNames(forms.methods, undefined)).toEqual({ checked: 0, fixed: 0, failed: 0 })
    forms.script.push('broken')
    expect(await repairFormsNames(forms.methods, part)).toEqual({ checked: 0, fixed: 0, failed: 0 })
    expect(forms.rows[0]).toMatchObject({ name: 'Acme Legal' })
  })
})
