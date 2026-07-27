-- The one reference mart shipped by the warehouse app template (ADR-0004): one row per
-- GitHub issue (PRs included, per `is_pull_request` — see stg_github_issues.sql) for the
-- repo connectors/github.py extracted. `external` materialization writes this straight
-- to a parquet file at WAREHOUSE_MART_DIR/mart_github_issues.parquet — the artifact the
-- container-side orchestrator uploads to R2 at marts/mart_github_issues.parquet
-- (worker/r2-keys.ts's martKey), alongside the sidecar it derives from this file's own
-- schema.yml (models/marts/schema.yml) after the run.
--
-- Column set, types, and descriptions here MUST match schema.yml exactly — schema.yml is
-- the mart contract's source of truth (CONTEXT.md "Mart Contract"), not this SELECT.

{{
  config(
    materialized='external',
    location=env_var('WAREHOUSE_MART_DIR', './marts') ~ '/mart_github_issues.parquet',
    format='parquet'
  )
}}

select
    issue_id,
    issue_number,
    title,
    state,
    is_pull_request,
    author_login,
    comment_count,
    created_at,
    updated_at,
    closed_at,
    html_url
from {{ ref('stg_github_issues') }}
order by issue_number
