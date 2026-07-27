import { describe, expect, test } from 'bun:test'
import { martKey, martSidecarKey } from '../shared/r2-keys'
import { materialize, type MaterializeDeps, type RunResult } from './materialize'

// Manifest fixtures below are trimmed to the fields materialize.ts actually reads, but
// shaped exactly like a real `dbt run` manifest.json — verified by actually running this
// package's own dbt/ project with dbt-duckdb==1.10.1 (see materialize.ts's file header
// for why catalog.json is NOT used): mart models are `resource_type: "model"` with
// `config.materialized === "external"` and `config.location` set to the absolute path
// `external` wrote the parquet to; a column with no `description` in schema.yml comes
// back as `description: ""`, never an absent key.

const MANIFEST_PATH = 'dbt/target/manifest.json'
// RELATIVE on purpose — this is the real shape of `config.location`
// (dbt/models/marts/mart_github_issues.sql resolves `env_var('WAREHOUSE_MART_DIR', './marts')`).
// Three separate processes resolve it against a shared cwd (dbt's COPY, the duckdb CLI in
// countRows, and Bun.file in readFile), which is exactly why materialize() has to `mkdir -p
// marts` first; an absolute fixture path would hide that coupling.
const PARQUET_PATH = './marts/mart_github_issues.parquet'

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

/** DuckDB's `describe` output for the columns validManifest() declares. Shaped like the real
 * `duckdb -json` rows (it reports types lowercase), so assertSidecarMatchesParquet is
 * exercised against realistic input rather than a shape invented to match the assertion. */
const DESCRIBED_COLUMNS = [
  { column_name: 'issue_id', column_type: 'bigint' },
  { column_name: 'title', column_type: 'varchar' },
]

const NOW = '2026-07-24T12:00:00.000Z'

interface Calls {
  run: string[][]
  upload: Array<{ key: string; bytes: Uint8Array }>
  remove: string[]
}

function baseDeps(overrides: Partial<MaterializeDeps> = {}): {
  deps: MaterializeDeps
  calls: Calls
} {
  const calls: Calls = { run: [], upload: [], remove: [] }

  const run = async (cmd: string[]): Promise<RunResult> => {
    calls.run.push(cmd)
    if (cmd[0] === 'duckdb') {
      const sql = cmd[cmd.length - 1] ?? ''
      if (sql.startsWith('describe')) {
        return { stdout: JSON.stringify(DESCRIBED_COLUMNS), stderr: '', code: 0 }
      }
      return { stdout: JSON.stringify([{ n: 2 }]), stderr: '', code: 0 }
    }
    return { stdout: '', stderr: '', code: 0 }
  }

  const upload = async (key: string, bytes: Uint8Array): Promise<void> => {
    calls.upload.push({ key, bytes })
  }

  const remove = async (key: string): Promise<void> => {
    calls.remove.push(key)
  }

  // Default: R2 holds exactly what this run publishes, so nothing is orphaned.
  const list = async (): Promise<string[]> => [
    martKey('mart_github_issues'),
    martSidecarKey('mart_github_issues'),
  ]

  // A single test connector, so these tests exercise the FRAMEWORK rather than depending on
  // the shipped GitHub sample continuing to exist (a consumer is expected to delete it).
  const connectors = [{ name: 'test', script: 'connectors/test.py', requiredEnv: ['TEST_TARGET'] }]

  return {
    deps: {
      run,
      readFile: readFileFor(validManifest()),
      upload,
      remove,
      list,
      env: (name: string) => (name === 'TEST_TARGET' ? 'set' : undefined),
      now: () => NOW,
      connectors,
      ...overrides,
    },
    calls,
  }
}

describe('materialize', () => {
  test('a mart with a described schema produces a valid uploaded sidecar', async () => {
    const { deps, calls } = baseDeps()

    const result = await materialize(deps)

    expect(result.marts).toEqual(['mart_github_issues'])

    // marts dir ensured, then connector, then dbt, ran before anything else
    expect(calls.run[0]).toEqual(['mkdir', '-p', 'marts'])
    expect(calls.run[1]).toEqual(['python3', 'connectors/test.py'])
    expect(calls.run[2]).toEqual(['dbt', 'run', '--project-dir', 'dbt', '--profiles-dir', 'dbt'])

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

    // Asserted as EQUALITY, not `.not.toContain`: a filter broken to match nothing would
    // yield [] and satisfy a not-contains check while publishing no marts at all.
    expect(result.marts).toEqual(['mart_github_issues'])
  })

  test('scopes the multiprocessing-lock patch to dbt, and pins dlt to a single worker', async () => {
    const envs: Array<{ cmd: string; env?: Record<string, string> }> = []
    const { deps } = baseDeps({
      run: async (cmd, env) => {
        envs.push({ cmd: cmd[0] ?? '', env })
        if (cmd[0] === 'duckdb') {
          const sql = cmd[cmd.length - 1] ?? ''
          if (sql.startsWith('describe')) {
            return { stdout: JSON.stringify(DESCRIBED_COLUMNS), stderr: '', code: 0 }
          }
          return { stdout: JSON.stringify([{ n: 2 }]), stderr: '', code: 0 }
        }
        return { stdout: '', stderr: '', code: 0 }
      },
    })

    await materialize(deps)

    // dbt gets the lock patch; the connector must NOT (a threading.RLock is unpicklable,
    // so it would break dlt's ProcessPoolExecutor rather than help it).
    const dbt = envs.find((e) => e.cmd === 'dbt')
    const connector = envs.find((e) => e.cmd === 'python3')
    expect(dbt?.env?.WAREHOUSE_PATCH_MP_LOCKS).toBe('1')
    expect(connector?.env?.WAREHOUSE_PATCH_MP_LOCKS).toBeUndefined()
    expect(connector?.env?.NORMALIZE__WORKERS).toBe('1')
  })

  test('retires the old sidecar BEFORE writing the parquet, so a failed run reads as absent', async () => {
    const { deps, calls } = baseDeps()

    await materialize(deps)

    // The ordering is the entire atomicity story: if the sidecar were written last without
    // first being removed, a crash between the two uploads would leave a NEW parquet
    // described by a STALE sidecar — served as a confident 200 with wrong metadata.
    const removedAt = calls.remove.indexOf(martSidecarKey('mart_github_issues'))
    const parquetAt = calls.upload.findIndex((u) => u.key === martKey('mart_github_issues'))
    const sidecarAt = calls.upload.findIndex((u) => u.key === martSidecarKey('mart_github_issues'))
    expect(removedAt).toBeGreaterThanOrEqual(0)
    expect(parquetAt).toBeLessThan(sidecarAt)
  })

  test('throws when the declared schema omits a column the parquet actually has', async () => {
    const { deps, calls } = baseDeps({
      run: async (cmd) => {
        if (cmd[0] === 'duckdb') {
          const sql = cmd[cmd.length - 1] ?? ''
          if (sql.startsWith('describe')) {
            return {
              stdout: JSON.stringify([
                ...DESCRIBED_COLUMNS,
                { column_name: 'assignee_login', column_type: 'varchar' },
              ]),
              stderr: '',
              code: 0,
            }
          }
          return { stdout: JSON.stringify([{ n: 2 }]), stderr: '', code: 0 }
        }
        return { stdout: '', stderr: '', code: 0 }
      },
    })

    await expect(materialize(deps)).rejects.toThrow(/assignee_login/)
    expect(calls.upload).toEqual([])
  })

  test('throws when the declared schema names a column the parquet does not have', async () => {
    const { deps, calls } = baseDeps({
      run: async (cmd) => {
        if (cmd[0] === 'duckdb') {
          const sql = cmd[cmd.length - 1] ?? ''
          if (sql.startsWith('describe')) {
            return { stdout: JSON.stringify([DESCRIBED_COLUMNS[0]]), stderr: '', code: 0 }
          }
          return { stdout: JSON.stringify([{ n: 2 }]), stderr: '', code: 0 }
        }
        return { stdout: '', stderr: '', code: 0 }
      },
    })

    await expect(materialize(deps)).rejects.toThrow(/title/)
    expect(calls.upload).toEqual([])
  })

  test('throws when a declared column type disagrees with the parquet', async () => {
    const { deps, calls } = baseDeps({
      run: async (cmd) => {
        if (cmd[0] === 'duckdb') {
          const sql = cmd[cmd.length - 1] ?? ''
          if (sql.startsWith('describe')) {
            return {
              stdout: JSON.stringify([
                { column_name: 'issue_id', column_type: 'varchar' },
                { column_name: 'title', column_type: 'varchar' },
              ]),
              stderr: '',
              code: 0,
            }
          }
          return { stdout: JSON.stringify([{ n: 2 }]), stderr: '', code: 0 }
        }
        return { stdout: '', stderr: '', code: 0 }
      },
    })

    await expect(materialize(deps)).rejects.toThrow(/issue_id.*BIGINT/s)
    expect(calls.upload).toEqual([])
  })

  test('accepts a lowercase data_type from schema.yml by normalizing it', async () => {
    const manifest = validManifest()
    manifest.nodes['model.warehouse.mart_github_issues'].columns.issue_id!.data_type = 'bigint'
    const { deps } = baseDeps({ readFile: readFileFor(manifest) })

    const result = await materialize(deps)
    expect(result.marts).toEqual(['mart_github_issues'])
  })

  test('a data_type outside the accepted vocabulary names the mart, column, and the legal set', async () => {
    const manifest = validManifest()
    manifest.nodes['model.warehouse.mart_github_issues'].columns.issue_id!.data_type = 'INTEGER'
    const { deps, calls } = baseDeps({ readFile: readFileFor(manifest) })

    await expect(materialize(deps)).rejects.toThrow(
      /mart_github_issues.*issue_id.*INTEGER.*VARCHAR, TIMESTAMP, BIGINT, DOUBLE, BOOLEAN/s,
    )
    expect(calls.upload).toEqual([])
  })

  test('throws when dbt declares no external models rather than reporting a silent success', async () => {
    const manifest = validManifest()
    manifest.nodes['model.warehouse.mart_github_issues'].config.materialized = 'view'
    const { deps, calls } = baseDeps({ readFile: readFileFor(manifest) })

    await expect(materialize(deps)).rejects.toThrow(/no external \(mart\) models/)
    expect(calls.upload).toEqual([])
  })

  test('reaps R2 artifacts for marts the dbt project no longer declares', async () => {
    const { deps, calls } = baseDeps({
      list: async () => [
        martKey('mart_github_issues'),
        martSidecarKey('mart_github_issues'),
        martKey('mart_retired'),
        martSidecarKey('mart_retired'),
      ],
    })

    await materialize(deps)

    expect(calls.remove).toContain(martKey('mart_retired'))
    expect(calls.remove).toContain(martSidecarKey('mart_retired'))
    // The live mart's parquet must survive; only its sidecar is retired-and-rewritten.
    expect(calls.remove).not.toContain(martKey('mart_github_issues'))
  })

  test("strips dbt-duckdb's all-NULL sentinel row so an empty mart is genuinely empty", async () => {
    // dbt-duckdb's external.sql deliberately inserts one all-NULL row when a model produces
    // no rows ("write a non-empty table with column names and null values"). Left alone, the
    // mart-read API serves that as a real record and the sidecar claims rowCount 1.
    const rewrites: string[][] = []
    const { deps, calls } = baseDeps({
      run: async (cmd) => {
        calls.run.push(cmd)
        if (cmd[0] === 'duckdb') {
          const sql = cmd[cmd.length - 1] ?? ''
          if (sql.startsWith('describe')) {
            return { stdout: JSON.stringify(DESCRIBED_COLUMNS), stderr: '', code: 0 }
          }
          if (sql.includes('filter (where')) {
            // One row, and it is entirely NULL — the sentinel's exact shape.
            return { stdout: JSON.stringify([{ total: 1, blanks: 1 }]), stderr: '', code: 0 }
          }
          if (sql.startsWith('copy')) {
            rewrites.push(cmd)
            return { stdout: '', stderr: '', code: 0 }
          }
          return { stdout: JSON.stringify([{ n: 0 }]), stderr: '', code: 0 }
        }
        return { stdout: '', stderr: '', code: 0 }
      },
      env: (name) => (name === 'TEST_TARGET' ? 'set' : undefined),
    })

    const result = await materialize(deps)

    expect(result.marts).toEqual(['mart_github_issues'])
    expect(rewrites.length).toBe(1)
    expect(calls.run.some((c) => c[0] === 'mv')).toBe(true)

    // And the published sidecar must say 0, not 1.
    const sidecarUpload = calls.upload.find((u) => u.key === martSidecarKey('mart_github_issues'))
    const sidecar = JSON.parse(new TextDecoder().decode(sidecarUpload?.bytes))
    expect(sidecar.rowCount).toBe(0)
  })

  test('leaves a populated mart untouched — no rewrite when there is no sentinel', async () => {
    const { deps, calls } = baseDeps()

    await materialize(deps)

    expect(calls.run.some((c) => c[0] === 'mv')).toBe(false)
  })

  test('refuses to run dbt at all when WAREHOUSE_RAW_DIR could escape a DuckDB string literal', async () => {
    // The staging model interpolates this straight into read_parquet('<value>/...'), so a
    // quote escapes into arbitrary SQL — verified exploitable end-to-end, landing a forged
    // row in a published mart that passes every downstream schema check. Must be caught
    // BEFORE dbt executes; validating config.location afterwards is too late by definition.
    const { deps, calls } = baseDeps({
      env: (name) =>
        name === 'WAREHOUSE_RAW_DIR'
          ? "./raw') union all select 999::bigint --"
          : name === 'TEST_TARGET'
            ? 'set'
            : undefined,
    })

    await expect(materialize(deps)).rejects.toThrow(/WAREHOUSE_RAW_DIR/)
    expect(calls.run.some((c) => c[0] === 'dbt')).toBe(false)
    expect(calls.upload).toEqual([])
  })

  test('rejects a config.location that could break out of the duckdb string literal', async () => {
    const manifest = validManifest()
    manifest.nodes['model.warehouse.mart_github_issues'].config.location =
      "./marts/x.parquet'); install shell; --"
    const { deps, calls } = baseDeps({ readFile: readFileFor(manifest) })

    await expect(materialize(deps)).rejects.toThrow(/unsafe config.location/)
    expect(calls.upload).toEqual([])
  })

  test('a mart model with no config.location throws before any upload', async () => {
    const manifest = validManifest()
    // @ts-expect-error deliberately removing a required fixture field
    delete manifest.nodes['model.warehouse.mart_github_issues'].config.location
    const { deps, calls } = baseDeps({ readFile: readFileFor(manifest) })

    await expect(materialize(deps)).rejects.toThrow(/config.location/)
    expect(calls.upload).toEqual([])
  })

  test('non-JSON output from duckdb names the step instead of throwing a bare SyntaxError', async () => {
    const { deps } = baseDeps({
      run: async (cmd) => {
        if (cmd[0] === 'duckdb') {
          return { stdout: 'extension autoload notice', stderr: '', code: 0 }
        }
        return { stdout: '', stderr: '', code: 0 }
      },
    })

    await expect(materialize(deps)).rejects.toThrow(/is not JSON/)
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

    // Matched, not bare: an unmatched `.rejects.toThrow()` passes on ANY error, including
    // an unrelated fixture mistake, so it would not actually pin the name-validation gate.
    await expect(materialize(deps)).rejects.toThrow(/mart name/)
    expect(calls.upload).toEqual([])
  })

  test('throws if a connector fails, and never runs dbt', async () => {
    const { deps, calls } = baseDeps({
      run: async (cmd) => {
        calls.run.push(cmd)
        if (cmd[0] === 'python3') return { stdout: '', stderr: 'boom', code: 1 }
        return { stdout: '', stderr: '', code: 0 }
      },
    })

    await expect(materialize(deps)).rejects.toThrow(/boom/)
    expect(calls.run).toEqual([
      ['mkdir', '-p', 'marts'],
      ['python3', 'connectors/test.py'],
    ])
    expect(calls.upload).toEqual([])
  })

  test('SKIPS an unconfigured connector but still runs, as long as another one extracted', async () => {
    const { deps, calls } = baseDeps({
      connectors: [
        { name: 'configured', script: 'connectors/a.py', requiredEnv: ['TEST_TARGET'] },
        { name: 'unwired', script: 'connectors/b.py', requiredEnv: ['NOT_SET'] },
      ],
    })

    const result = await materialize(deps)

    expect(result.marts).toEqual(['mart_github_issues'])
    const scripts = calls.run.filter((c) => c[0] === 'python3').map((c) => c[1])
    expect(scripts).toEqual(['connectors/a.py'])
    expect(calls.run.some((c) => c[0] === 'dbt')).toBe(true)
  })

  test('REFUSES to publish when EVERY connector was skipped — no fresh stamp without an extract', async () => {
    const { deps, calls } = baseDeps({
      // Nothing configured at all. In a warm container ./raw still holds the previous run's
      // data, so dbt would rebuild the same mart and we'd stamp it as freshly generated —
      // a mart that claims to be current forever while nothing is being fetched.
      env: () => undefined,
    })

    await expect(materialize(deps)).rejects.toThrow(/every declared connector was skipped/)
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

  test('surfaces stdout in the failure, not just stderr — dbt writes its real errors there', async () => {
    const { deps } = baseDeps({
      run: async (cmd) => {
        if (cmd[0] === 'dbt')
          return { stdout: 'Compilation Error in model mart_x', stderr: '', code: 2 }
        return { stdout: '', stderr: '', code: 0 }
      },
    })

    await expect(materialize(deps)).rejects.toThrow(/Compilation Error in model mart_x/)
  })
})
