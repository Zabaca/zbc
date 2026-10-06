// The reminder filter is a Claude Code plugin, so its own tests run under
// Claude Code, not under bun: `claude plugin validate` reads it the way the
// engine will, and `claude plugin test` runs mods/reminders/tests against the
// engine itself. Both run here on the binary the Agent SDK bundles, which is
// the one every minimalOptions() agent actually loads the filter into: a
// version that cannot load it fails this file, not a deploy.
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { REMINDER_FILTER } from './index'
import { claudeExecutable, srtSettings } from './sandbox'

const claude = claudeExecutable()

test('the filter validates as a plugin', () => {
  const r = spawnSync(claude, ['plugin', 'validate', REMINDER_FILTER], { encoding: 'utf8' })
  expect(r.status, r.stdout + r.stderr).toBe(0)
  expect(r.stdout).toContain('hooks: prompt.attachment')
})

test("the filter's own tests pass under the bundled engine", () => {
  const r = spawnSync(claude, ['plugin', 'test', REMINDER_FILTER], { encoding: 'utf8' })
  const out = r.stdout + r.stderr
  expect(r.status, out).toBe(0)
  expect(out).toContain('0 fail')
})

test('the sandbox lets the CLI read the filter, or it would fail open', () => {
  // Pure settings: no sandbox runtime needed to check what it would allow.
  const { filesystem } = srtSettings({ dir: '/tmp/zbc-ws', home: '/tmp/zbc-ws-home' })
  expect(filesystem.allowRead).toContain(REMINDER_FILTER)
})
