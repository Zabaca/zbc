// The connector registry — the seam that makes "framework + one reference connector"
// (ADR-0004) true in the CODE and not just in prose.
//
// Before this existed, `container/materialize.ts` hardcoded `python3 connectors/github.py`,
// the framework's Env interface named GITHUB_* directly, and registry.json listed
// GITHUB_TOKEN as a required secret — so the "sample" was welded into three framework files
// and adding a second connector meant editing template-owned code that every future
// `zbc add` would conflict with. Here, a connector is data: adding one is an entry in this
// array plus a script, and removing the GitHub sample is deleting an entry.
//
// Each connector runs one-shot inside a materialize run, in declaration order, before dbt.
// Its `env` names are read from the container's own environment (forwarded from the Worker's
// workerSecrets/workerVars — see worker/materialize-dispatch.ts) and passed through to the
// script; a connector whose required env is missing is SKIPPED with a log line rather than
// failing the run, so a project that hasn't wired GitHub does not get a daily failing cron.

export interface Connector {
  /** Identifier used in logs and skip messages. */
  name: string
  /** Script path relative to the container's /app working directory. */
  script: string
  /**
   * Environment variable names this connector needs. All must be present and non-empty for
   * it to run — otherwise it is skipped. Put the connector's SECRETS in the instance's
   * `workerSecrets` and its non-secret targeting config in `workerVars`; both arrive here
   * the same way.
   */
  requiredEnv: string[]
}

export const CONNECTORS: Connector[] = [
  {
    name: 'github',
    script: 'connectors/github.py',
    // GITHUB_TOKEN is deliberately NOT required: the GitHub API serves public repos
    // unauthenticated at a low rate limit, which is enough for a first run before anyone has
    // minted a PAT. Owner/repo are what the connector genuinely cannot work without.
    requiredEnv: ['GITHUB_OWNER', 'GITHUB_REPO'],
  },
]
