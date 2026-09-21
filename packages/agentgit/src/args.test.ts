/**
 * The command line. Every assertion is about what the watcher would DO, since
 * a flag misread here is a clone that quietly stops updating.
 */

import { describe, expect, test } from 'bun:test'

import { parseArgs } from './args'

const watch = (argv: string[]) => {
  const parsed = parseArgs(argv)
  if (parsed.kind !== 'watch') throw new Error(`expected watch, got ${parsed.kind}`)
  return parsed.options
}

describe('parseArgs', () => {
  test('no arguments at all is the help, not an error', () => {
    expect(parseArgs([]).kind).toBe('help')
  })

  test('bare `watch` asks for everything to be discovered', () => {
    const options = watch(['watch'])
    expect(options.targets.size).toBe(0)
    expect(options.refs).toEqual([])
    expect(options.fetch).toBe(true)
  })

  test('a bare repository name takes the current checkout', () => {
    expect([...watch(['watch', 'study-42']).targets]).toEqual([['study-42', '']])
  })

  test('repo=dir pairs name several checkouts on one socket', () => {
    expect([...watch(['watch', 'a=../a', 'b=../b']).targets]).toEqual([
      ['a', '../a'],
      ['b', '../b'],
    ])
  })

  test('several repositories without directories is refused, not guessed', () => {
    expect(parseArgs(['watch', 'a', 'b'])).toMatchObject({ kind: 'error' })
  })

  test('--ref is repeatable', () => {
    expect(watch(['watch', '--ref', 'refs/heads/main', '--ref', 'refs/heads/review']).refs).toEqual(
      ['refs/heads/main', 'refs/heads/review'],
    )
  })

  test('--all-refs and --ref cannot both be meant', () => {
    expect(parseArgs(['watch', '--all-refs', '--ref', 'refs/heads/main'])).toMatchObject({
      kind: 'error',
    })
  })

  test('a flag missing its value is an error rather than swallowing the next flag', () => {
    expect(parseArgs(['watch', '--ref', '--json'])).toMatchObject({ kind: 'error' })
  })

  // An empty string is the third spelling of "no value", and the one that used
  // to get through: `--host ''` survived every null check downstream and became
  // a socket URL with no host in it.
  test('an empty value is refused for every flag that takes one', () => {
    for (const flag of ['--ref', '--host', '--token', '--on']) {
      expect(parseArgs(['watch', flag, ''])).toMatchObject({
        kind: 'error',
        message: `${flag} needs a value`,
      })
    }
  })

  test('the modes that change what happens on an event', () => {
    const options = watch(['watch', '--once', '--no-fetch', '--json', '--on', 'bun test'])
    expect(options.once).toBe(true)
    expect(options.fetch).toBe(false)
    expect(options.json).toBe(true)
    expect(options.onChange).toBe('bun test')
  })

  test('--ff-on-clean is off unless it is asked for', () => {
    expect(watch(['watch']).ffOnClean).toBe(false)
    expect(watch(['watch', '--ff-on-clean']).ffOnClean).toBe(true)
  })

  test('--ff-on-clean with --no-fetch is refused, not quietly ignored', () => {
    // Nothing was fetched, so there is nothing to fast-forward onto. The two
    // together read as a request that cannot be honoured.
    expect(parseArgs(['watch', '--ff-on-clean', '--no-fetch'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['watch', '--no-fetch', '--ff-on-clean'])).toMatchObject({ kind: 'error' })
  })

  test('an unknown flag or command is named rather than ignored', () => {
    expect(parseArgs(['watch', '--follow'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['pull'])).toMatchObject({ kind: 'error' })
  })

  test('git calls the helper with exactly one of three operations', () => {
    expect(parseArgs(['credential', 'get'])).toEqual({ kind: 'credential', operation: 'get' })
    expect(parseArgs(['credential', 'store'])).toEqual({ kind: 'credential', operation: 'store' })
    expect(parseArgs(['credential', 'erase'])).toEqual({ kind: 'credential', operation: 'erase' })
  })

  test('a credential operation git does not have is an error, not a silent get', () => {
    expect(parseArgs(['credential'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['credential', 'approve'])).toMatchObject({ kind: 'error' })
  })

  test('setup takes the host from the clone, or from an argument', () => {
    expect(parseArgs(['setup'])).toEqual({ kind: 'setup', host: null, global: true })
    expect(parseArgs(['setup', 'agentgit.zabaca.com'])).toEqual({
      kind: 'setup',
      host: 'agentgit.zabaca.com',
      global: true,
    })
    expect(parseArgs(['setup', '--local'])).toEqual({ kind: 'setup', host: null, global: false })
  })

  test('help and version are reachable from anywhere', () => {
    expect(parseArgs(['--help']).kind).toBe('help')
    expect(parseArgs(['watch', '--help']).kind).toBe('help')
    expect(parseArgs(['-v']).kind).toBe('version')
  })
})

describe('parseArgs: accept', () => {
  test('accept takes exactly one Proposal id', () => {
    expect(parseArgs(['accept', 'fix-auth'])).toEqual({ kind: 'accept', id: 'fix-auth' })
  })

  test('no id, or more than one, is an error rather than a guess', () => {
    expect(parseArgs(['accept'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['accept', 'a', 'b'])).toMatchObject({ kind: 'error' })
  })

  test('accept --help is the help, and an unknown flag is named', () => {
    expect(parseArgs(['accept', '--help']).kind).toBe('help')
    expect(parseArgs(['accept', '--force', 'fix-auth'])).toMatchObject({ kind: 'error' })
  })
})

describe('parseArgs: watch --proposals', () => {
  test('the flag is off unless it is typed', () => {
    const bare = parseArgs(['watch'])
    expect(bare).toMatchObject({ kind: 'watch' })
    expect((bare as { options: { proposals: boolean } }).options.proposals).toBe(false)
  })

  test('--proposals turns the Proposal namespace on', () => {
    const parsed = parseArgs(['watch', '--proposals'])
    expect(parsed).toMatchObject({ kind: 'watch' })
    expect((parsed as { options: { proposals: boolean } }).options.proposals).toBe(true)
  })

  test('--proposals and --all-refs are refused: a namespace needs a branch', () => {
    expect(parseArgs(['watch', '--proposals', '--all-refs'])).toMatchObject({ kind: 'error' })
  })
})
