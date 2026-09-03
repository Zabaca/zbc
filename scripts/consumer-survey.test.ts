import { describe, expect, test } from 'bun:test'
import {
  classify,
  findEscapeHatches,
  normalize,
  revision as rev,
  schemaKeys,
  similarity,
} from './consumer-survey'

const v1 = `export const m = defineModule({ name: 'd1', apply() { return 1 } })`
const v2 = `export const m = defineModule({ name: 'd1', apply() { return 2 } })`

describe('classify', () => {
  test('a verbatim copy of any past revision is stale, not a consumer idea', () => {
    const history = [rev('newest', v2), rev('older', v1)]
    expect(classify(v1, history)).toEqual({ verdict: 'stale', matchedRev: 'older' })
  })

  test('a copy of the newest revision is current, not upgrade debt', () => {
    expect(classify(v2, [rev('newest', v2), rev('older', v1)])).toEqual({
      verdict: 'current',
      matchedRev: 'newest',
    })
  })

  test('a module with no upstream of that name is novel', () => {
    expect(classify(v1, [])).toEqual({ verdict: 'novel' })
  })

  test('a reformatted copy is not an edit — quote style is not a consumer idea', () => {
    const prettier = `export const m = defineModule({ name: "d1", apply() { return 1 } });`
    expect(classify(prettier, [rev('newest', v2), rev('older', v1)])).toEqual({
      verdict: 'stale',
      matchedRev: 'older',
      formattingOnly: true,
    })
  })

  test('an edited copy is divergent and names the revision to diff against', () => {
    const edited = `${v1}\n// plus a thing we needed`
    const result = classify(edited, [rev('newest', v2), rev('older', v1)])
    expect(result.verdict).toBe('divergent')
    expect(result.nearestRev).toBe('older')
    expect(result.similarity).toBeGreaterThan(0)
  })

  test('nearest is by content, not by recency — the point is a readable diff', () => {
    const drifted = `${v1}\n// one extra line`
    // 'newest' is first in history but 'ancestor' is what they actually forked.
    const result = classify(drifted, [rev('newest', 'a\nb\nc\nd\ne\nf'), rev('ancestor', v1)])
    expect(result.nearestRev).toBe('ancestor')
  })
})

describe('similarity', () => {
  test('identical content scores 1', () => {
    expect(similarity(v1, v1)).toBe(1)
  })

  test('nothing shared scores 0', () => {
    expect(similarity('a\nb', 'c\nd')).toBe(0)
  })

  test('blank lines and indentation do not count as difference', () => {
    expect(similarity('a\n\n  b', 'a\nb')).toBe(1)
  })
})

describe('schemaKeys', () => {
  const source = `
export const d1Module = defineModule({
  name: 'd1',
  configSchema: z.object({
    accountId: z.string(),
    dbName: z.string(),
    migrations: z.object({ dir: z.string(), apply: z.boolean() }).optional(),
  }),
  outputs: z.object({
    databaseId: z.string(),
  }),
})`

  test('reads the top-level config keys that make up the interface', () => {
    expect(schemaKeys(source, 'configSchema')).toEqual(['accountId', 'dbName', 'migrations'])
  })

  test('nested keys are not top-level keys', () => {
    expect(schemaKeys(source, 'configSchema')).not.toContain('dir')
  })

  test('outputs read the same way', () => {
    expect(schemaKeys(source, 'outputs')).toEqual(['databaseId'])
  })

  test('a schema built some other way reports nothing rather than guessing', () => {
    expect(schemaKeys('const s = buildSchema()', 'configSchema')).toEqual([])
  })
})

describe('findEscapeHatches', () => {
  test('a provider CLI outside a module is the gap worth finding', () => {
    const hatches = findEscapeHatches([
      { path: 'scripts/deploy.sh', content: 'set -e\nwrangler deploy --env production' },
    ])
    expect(hatches).toEqual([
      {
        file: 'scripts/deploy.sh',
        line: 2,
        tool: 'wrangler',
        snippet: 'wrangler deploy --env production',
      },
    ])
  })

  test('the same call inside a module is the module doing its job', () => {
    expect(
      findEscapeHatches([
        { path: 'packages/infra/modules/cloudflare/index.ts', content: 'exec("wrangler deploy")' },
      ]),
    ).toEqual([])
  })

  test('comments mentioning a CLI are not calls to it', () => {
    expect(
      findEscapeHatches([{ path: 'scripts/a.ts', content: '// run wrangler deploy by hand' }]),
    ).toEqual([])
  })
})

describe('revision', () => {
  test('carries the date, so a reviewer can see which side is older', () => {
    expect(rev('abc', v1, '2026-08-19').date).toBe('2026-08-19')
  })
})

describe('normalize', () => {
  test('quote style, trailing punctuation, indent and blank lines all collapse', () => {
    expect(normalize('  const a = "x";\n\n  const b = [1,];\n')).toBe(
      "const a = 'x'\nconst b = [1,]",
    )
  })

  test('comments survive — a consumer comment is often the finding', () => {
    expect(normalize('// recon was public for 20 minutes\ncode()')).toContain(
      '// recon was public for 20 minutes',
    )
  })
})
