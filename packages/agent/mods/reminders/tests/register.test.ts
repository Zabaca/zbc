import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const reminder = {
  type: 'date',
  text: "Today's date is 2026-10-06.",
  origin: { kind: 'engine' },
} as const

// Stands for the engine beneath the plugin: renders the reminder as it was.
const engine = (on: On) => on('prompt.attachment', (_$, e) => ({ text: e.text }))

test('every reminder is dropped when nothing is kept', async ($, on) => {
  mock.env(on, {})
  engine(on)
  expect(await $.prompt.attachment(reminder as never)).toEqual({ text: null })
})

test('a kept type passes through untouched, and the rest are still dropped', async ($, on) => {
  mock.env(on, { ZBC_AGENT_KEEP_REMINDERS: 'environment, date' })
  engine(on)
  expect((await $.prompt.attachment(reminder as never)).text).toBe(reminder.text)
  const model = { type: 'model', text: 'You are powered by…', origin: { kind: 'engine' } } as const
  expect(await $.prompt.attachment(model as never)).toEqual({ text: null })
})
