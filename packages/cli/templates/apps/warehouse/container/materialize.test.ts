import { describe, expect, test } from 'bun:test'
import { martKey, martSidecarKey } from '../worker/r2-keys'
import { materialize, type MaterializeDeps, type RunResult } from './materialize'

// Manifest fixtures below are trimmed to the fields materialize.ts actually reads, but
// shaped exactly like a real `dbt run` manifest.json — verified by actually running this
// package's own dbt/ project with dbt-duckdb==1.10.1 (see materialize.ts's file header
// for why catalog.json is NOT used): mart models are `resource_type: "model"` with
// `config.materialized === "external"` and `config.location` set to the absolute path
// `external` wrote the parquet to; a column with no `description` in schema.yml comes
// back as `description: ""`, never an absent key.

const MANIFEST_PATH = 'dbt/target/manifest.json'
const PARQUET_PATH = '/work/marts/mart_github_issues.parquet'

interface FixtureManifest {
  nodes: {
    'model.warehouse.stg_github_issues': {
      resource_type: string
      name: string
      description: string
      columns: Record<string, never>
      config: { materialized: string }
    }
    'model.warehouse.mart_github_issues': {
      resource_type: string
      name: string
      description: string
      columns: Record<string, { name: string; description: string; data_type: string }>
      config: { materialized: string; location: string }
    }
  }
}

function validManifest(): FixtureManifest {
  return {
    nodes: {
      'model.warehouse.stg_github_issues': {
        resource_type: 'model',
        name: 'stg_github_issues',
        description: 'Raw-to-typed reshaping.',
        columns: {},
        config: { materialized: 'view' },
      },
      'model.warehouse.mart_github_issues': {
        resource_type: 'model',
        name: 'mart_github_issues',
        description: 'One row per GitHub issue.',
        columns: {
          issue_id: { name: 'issue_id', description: "GitHub's issue id.", data_type: 'BIGINT' },
          title: { name: 'title', description: 'Issue title.', data_type: 'VARCHAR' },
        },
        config: { materialized: 'external', location: PARQUET_PATH },
      },
    },
  }
}

function encodedManifest(manifest: FixtureManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(manifest))
}

function readFileFor(manifest: FixtureManifest): MaterializeDeps['readFile'] {
  return async (path) => {
    if (path === MANIFEST_PATH) return encodedManifest(manifest)
    if (path === PARQUET_PATH) return new Uint8Array([1, 2, 3, 4])
    throw new Error(`unexpected readFile path: ${path}`)
  }
}

function baseDeps(overrides: Partial<MaterializeDeps> = {}): {
  deps: MaterializeDeps
  calls: { run: string[][]; upload: Array<{ key: string; bytes: Uint8Array }> }
} {
  const calls = { run: [] as string[][], upload: [] as Array<{ key: string; bytes: Uint8Array }> }

  const run = async (cmd: string[]): Promise<RunResult> => {
    calls.run.push(cmd)
    if (cmd[0] === 'duckdb') {
      return { stdout: JSON.stringify([{ n: 2 }]), stderr: '', code: 0 }
    }
    return { stdout: '', stderr: '', code: 0 }
  }

  const upload = async (key: string, bytes: Uint8Array): Promise<void> => {
    calls.upload.push({ key, bytes })
  }

  const now = () => '2026-07-24T12:00:00.000Z'

  return { deps: { run, readFile: readFileFor(validManifest()), upload, now, ...overrides }, calls }
}

describe('materialize', () => {
  test('a mart with a described schema produces a valid uploaded sidecar', async () => {
    const { deps, calls } = baseDeps()

    const result = await materialize(deps)

    expect(result.marts).toEqual(['mart_github_issues'])

    // connector, then dbt, ran before anything else
    expect(calls.run[0]).toEqual(['python3', 'connectors/github.py'])
    expect(calls.run[1]).toEqual(['dbt', 'run', '--project-dir', 'dbt', '--profiles-dir', 'dbt'])

    const parquetUpload = calls.upload.find((u) => u.key === martKey('mart_github_issues'))
    const sidecarUpload = calls.upload.find((u) => u.key === martSidecarKey('mart_github_issues'))
    expect(parquetUpload).toBeDefined()
    expect(parquetUpload?.bytes).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(sidecarUpload).toBeDefined()

    const sidecar = JSON.parse(new TextDecoder().decode(sidecarUpload?.bytes))
    expect(sidecar).toEqual({
      name: 'mart_github_issues',
      description: 'One row per GitHub issue.',
      columns: [
        { name: 'issue_id', type: 'BIGINT', description: "GitHub's issue id." },
        { name: 'title', type: 'VARCHAR', description: 'Issue title.' },
      ],
      generatedAt: '2026-07-24T12:00:00.000Z',
      rowCount: 2,
    })
  })

  test('skips non-external (staging) models — only marts are published', async () => {
    const { deps } = baseDeps()

    const result = await materialize(deps)

    expect(result.marts).not.toContain('stg_github_issues')
  })

  test('a mart model missing a column description throws before any upload call happens', async () => {
    const manifest = validManifest()
    manifest.nodes['model.warehouse.mart_github_issues'].columns.issue_id!.description = ''
    const { deps, calls } = baseDeps({ readFile: readFileFor(manifest) })

    await expect(materialize(deps)).rejects.toThrow(/issue_id/)

    expect(calls.upload).toEqual([])
  })

  test('a mart model with no description throws before any upload call happens', async () => {
    const manifest = validManifest()
    manifest.nodes['model.warehouse.mart_github_issues'].description = ''
    const { deps, calls } = baseDeps({ readFile: readFileFor(manifest) })

    await expect(materialize(deps)).rejects.toThrow(/mart_github_issues/)

    expect(calls.upload).toEqual([])
  })

  test('an invalid mart name throws before any upload call happens (MartSidecarSchema gate)', async () => {
    const manifest = validManifest()
    manifest.nodes['model.warehouse.mart_github_issues'].name = 'Mart-Github-Issues'
    const { deps, calls } = baseDeps({ readFile: readFileFor(manifest) })

    await expect(materialize(deps)).rejects.toThrow()
    expect(calls.upload).toEqual([])
  })

  test('throws if the GitHub connector fails, and never runs dbt', async () => {
    const { deps, calls } = baseDeps({
      run: async (cmd) => {
        calls.run.push(cmd)
        if (cmd[0] === 'python3') return { stdout: '', stderr: 'boom', code: 1 }
        return { stdout: '', stderr: '', code: 0 }
      },
    })

    await expect(materialize(deps)).rejects.toThrow(/boom/)
    expect(calls.run).toEqual([['python3', 'connectors/github.py']])
    expect(calls.upload).toEqual([])
  })

  test('throws if dbt run fails, and never uploads', async () => {
    const { deps, calls } = baseDeps({
      run: async (cmd) => {
        calls.run.push(cmd)
        if (cmd[0] === 'dbt') return { stdout: '', stderr: 'compilation error', code: 1 }
        return { stdout: '', stderr: '', code: 0 }
      },
    })

    await expect(materialize(deps)).rejects.toThrow(/compilation error/)
    expect(calls.upload).toEqual([])
  })
})
