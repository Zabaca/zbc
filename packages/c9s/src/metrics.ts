// Worker request metrics, from the GraphQL Analytics API. Separate from the REST
// list calls both because it is a different endpoint and because it is allowed to
// fail: a token without analytics scope should still get a usable Workers table.
import { type Cf, graphql } from './cf'

export type Metric = { requests: number; errors: number; p50: number; p99: number }

const QUERY = `query($account: string!, $since: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workersInvocationsAdaptive(limit: 500, filter: { datetime_geq: $since }) {
      dimensions { scriptName }
      sum { requests errors }
      quantiles { cpuTimeP50 cpuTimeP99 }
    }
  } }
}`

type Response = {
  viewer: {
    accounts: {
      workersInvocationsAdaptive: {
        dimensions: { scriptName: string }
        sum: { requests: number; errors: number }
        quantiles: { cpuTimeP50: number; cpuTimeP99: number }
      }[]
    }[]
  }
}

/** Last 24h, keyed by script name. Empty map on any failure, never throws. */
export async function workerMetrics(cf: Cf): Promise<Map<string, Metric>> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const out = new Map<string, Metric>()
  try {
    const data = await graphql<Response>(cf, QUERY, { account: cf.accountId, since })
    for (const r of data.viewer.accounts[0]?.workersInvocationsAdaptive ?? []) {
      out.set(r.dimensions.scriptName, {
        requests: r.sum.requests,
        errors: r.sum.errors,
        p50: r.quantiles.cpuTimeP50,
        p99: r.quantiles.cpuTimeP99,
      })
    }
  } catch (e) {
    // Analytics is a bonus column, not a reason to show an empty table. This also
    // swallows a genuine breakage (CF renaming the dataset, say), which reads
    // identically to a token without analytics scope: `-` in REQ/ERR/P50 forever.
    // C9S_DEBUG rethrows the original so the two can be told apart.
    if (process.env.C9S_DEBUG) throw e
  }
  return out
}

/** Microseconds of CPU, as the API reports them. */
export function micros(us: number | undefined): string {
  if (us == null) return '-'
  return us >= 1000 ? `${(us / 1000).toFixed(1)}ms` : `${us}µs`
}
