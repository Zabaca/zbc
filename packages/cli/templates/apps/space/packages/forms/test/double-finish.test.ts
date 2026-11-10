// A signer pressing Finish twice at once. The harness clock does not move, so both presses make the identical event (same
// millisecond, same fields, same hash). The press that loses the race for the chain must write nothing and change nothing:
// no second `signed` event, no second "your turn" email to the next signer, and an answer that says it lost.
import { beforeEach, expect, test } from 'bun:test'
import { harness } from './harness'
import { ALICE, BOB, kit } from './signing-kit'

const h = harness()
const k = kit(h)
beforeEach(() => h.reset())

test('a second Finish in the same millisecond is refused and sends the next signer no second email', async () => {
  const { id } = await k.sent({ recipients: [ALICE, BOB], order: 'sequential' })
  const token = k.tokenFor('alice@example.test')
  await k.signAs(token, 'Alice Example', { skipFinish: true })
  const press = k.as(token)

  // The second press is made while the first one's batch is being written, which is the interleaving two requests at once produce.
  const env = h.env()
  const real = env.DB
  let second: { status: number } | undefined
  let armed = true
  env.DB = {
    prepare: (sql: string) => real.prepare(sql),
    batch: async (statements: unknown[]) => {
      if (armed) {
        armed = false
        env.DB = real
        second = await press('POST', '/finish', { intent: true })
      }
      return real.batch(statements as never)
    },
  } as never
  const first = await press('POST', '/finish', { intent: true })

  expect(second, 'the second press ran').toBeDefined()
  expect([first.status, second!.status].filter((s) => s === 200)).toHaveLength(1)
  expect([first.status, second!.status].filter((s) => s !== 200).every((s) => s === 409 || s === 410)).toBe(true)
  expect(k.events(id).filter((e: { action: string }) => e.action === 'signed')).toHaveLength(1)
  expect(h.sql("SELECT id FROM mail WHERE envelope_id = ? AND kind = 'turn'", id)).toHaveLength(1)
  expect(h.outbox.filter((m: { to: { email: string } }) => m.to.email === 'bob@example.test')).toHaveLength(1)
})
