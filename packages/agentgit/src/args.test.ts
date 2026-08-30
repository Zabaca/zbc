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

  test('the modes that change what happens on an event', () => {
    const options = watch(['watch', '--once', '--no-fetch', '--json', '--on', 'bun test'])
    expect(options.once).toBe(true)
    expect(options.fetch).toBe(false)
    expect(options.json).toBe(true)
    expect(options.onChange).toBe('bun test')
  })

  test('an unknown flag or command is named rather than ignored', () => {
    expect(parseArgs(['watch', '--follow'])).toMatchObject({ kind: 'error' })
    expect(parseArgs(['pull'])).toMatchObject({ kind: 'error' })
  })

  test('help and version are reachable from anywhere', () => {
    expect(parseArgs(['--help']).kind).toBe('help')
    expect(parseArgs(['watch', '--help']).kind).toBe('help')
    expect(parseArgs(['-v']).kind).toBe('version')
  })
})
