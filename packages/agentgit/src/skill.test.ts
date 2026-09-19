/**
 * The skill and the host cannot drift.
 *
 * `plugin/skills/agentgit/SKILL.md` teaches an agent the same flows
 * `https://agentgit.co/llms.txt` teaches one that went looking, and the failure
 * mode of two documents saying the same thing is that one of them stops being
 * true. A wrong ref namespace or a dropped `--signed` in a skill is worse than
 * no skill: the agent is confident and the push is refused.
 *
 * So every line of every `sh` block in the skill must appear VERBATIM in the
 * rendered manual. That is the fence's meaning, and it is why the skill's
 * client-only commands — `agentgit accept`, `claude mcp add` — sit in `bash`
 * fences instead: the manual is about the protocol, not about this client's
 * command line.
 */

import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  type CapabilityEnv,
  capabilitiesFrom,
} from '../../cli/templates/apps/walgit/shared/capabilities'
import { renderLlms } from '../../cli/templates/apps/walgit/shared/llms'

const SKILL = path.join(import.meta.dir, '..', 'plugin', 'skills', 'agentgit', 'SKILL.md')

/**
 * agentgit.co's capabilities, as `packages/infra/environments/production/
 * walgit-public.ts` sets them: public, append-only, an event stream, signed
 * pushes, Signer Lists, Private names and Proposals.
 */
const AGENTGIT_CO: CapabilityEnv = {
  WALGIT_PUBLIC: '1',
  WALGIT_APPEND_ONLY: '1',
  WALGIT_EVENTS_URL: 'https://agentgit.co/_walgit/publish',
  WALGIT_EVENTS_TOKEN: 'token',
  WALGIT_PUSH_CERT_SEED: 'seed',
  WALGIT_SIGNER_LISTS: '1',
  WALGIT_PRIVATE_REPOS: 'seed',
  WALGIT_PROPOSALS: '1',
}

const manual = renderLlms('agentgit.co', capabilitiesFrom(AGENTGIT_CO))
const skill = fs.readFileSync(SKILL, 'utf8')

/** Every line inside a ```sh fence — the ones that are claims about the host. */
function shellLines(markdown: string): string[] {
  const lines: string[] = []
  let inside = false
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) {
      inside = line.trim() === '```sh'
      continue
    }
    if (inside && line.trim() !== '') lines.push(line)
  }
  return lines
}

describe('the agentgit skill', () => {
  test('is a skill Claude Code can load', () => {
    expect(skill.startsWith('---\n')).toBe(true)
    expect(skill).toContain('\nname: agentgit\n')
    expect(skill).toMatch(/\ndescription: \S/)
  })

  test('quotes only commands the host’s own manual states', () => {
    const quoted = shellLines(skill)
    // A guard on the guard: a fence rename would empty this and pass silently.
    expect(quoted.length).toBeGreaterThan(20)

    expect(quoted.filter((line) => !manual.includes(line))).toEqual([])
  })

  test('covers the flows the manual covers', () => {
    for (const heading of [
      '## Push something you already have',
      '## Start from nothing',
      '## Read somebody else',
      '## Hold a name',
      '## Propose a change',
      '## Accept a Proposal',
      '## Wait for the other agent to push',
      '## The credential helper',
    ]) {
      expect(skill).toContain(heading)
    }
  })
})
