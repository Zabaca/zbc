-- Raw-to-typed reshaping of what connectors/github.py landed: dlt's REST API source
-- writes every field GitHub's issues endpoint returns (100+ columns, nested objects
-- flattened with `__` by dlt's normalizer, e.g. `user__login`) — this model narrows
-- that down to the columns the mart actually needs and gives them mart-facing names.
--
-- WAREHOUSE_RAW_URL is resolved once by container/materialize.ts and injected into BOTH the
-- connector step and this dbt step, so a run's transform reads exactly what its own extract
-- just wrote. It is an `s3://<bucket>/raw` URL in a deployed container (read via DuckDB's
-- httpfs extension, configured by the R2 secret in dbt/profiles.yml) and a local path when
-- the connector is run standalone.
--
-- GitHub's REST API models a pull request as an issue with a non-null `pull_request`
-- field — `is_pull_request` makes that explicit instead of leaving it an implicit
-- artifact of the source API a mart consumer would have to know to check for.

-- Raw is APPEND-ONLY and durable (docs/adr/0004): each run adds only the issues GitHub
-- reported as updated since the last cursor, so the same issue_id appears once per run that
-- touched it, plus one extra from every run boundary (GitHub's `since` is inclusive). The mart
-- promises one row per issue, so collapse to the newest state per issue here. `_dlt_load_id`
-- breaks ties within a single updated_at — it is monotonic per load, so two rows landed with
-- an identical updated_at still resolve deterministically rather than by file order.
with deduplicated as (
    select
        *,
        row_number() over (
            partition by id
            order by updated_at desc, _dlt_load_id desc
        ) as _row_rank
    -- union_by_name is REQUIRED, not defensive. Raw is durable and append-only, so this glob
    -- spans files written months apart, and their schemas WILL diverge — GitHub adds response
    -- fields, and dlt's own normalizer settings change what it emits (add_dlt_load_id did
    -- exactly that here).
    --
    -- Measured against duckdb 1.5.5 with two parquet files where the second has an extra
    -- column: the default read_parquet SILENTLY DROPS it. No error, no warning — the result
    -- is simply bound to the first file's schema, so a column that exists in most of the raw
    -- layer vanishes from the mart and the only symptom is data that was never there. That
    -- silence is the reason this is not optional: a loud failure would at least be noticed.
    -- Matching by name and filling absent columns with NULL is the only correct read of a raw
    -- layer whose schema evolves over its lifetime.
    from read_parquet(
        '{{ env_var("WAREHOUSE_RAW_URL", "./raw") }}/github/issues/*.parquet',
        union_by_name := true
    )
)

select
    id as issue_id,
    number as issue_number,
    title,
    state,
    user__login as author_login,
    comments as comment_count,
    pull_request__url is not null as is_pull_request,
    -- `at time zone 'UTC'` is NOT decoration. dlt lands these as TIMESTAMP WITH TIME ZONE,
    -- and a bare `cast(tstz as timestamp)` in DuckDB converts to the SESSION time zone and
    -- then drops the offset — so the value silently shifts by whatever TZ the container
    -- happens to have, while the column keeps its name, its TIMESTAMP type, and this mart's
    -- schema.yml promise that it is "in UTC". Every downstream guard passes and the data is
    -- simply wrong. Pinning the zone here makes the conversion independent of the
    -- environment (the Dockerfile also sets ENV TZ=UTC, and TZ is blocked from crossing into
    -- the container — three layers, because the failure is invisible).
    cast(created_at at time zone 'UTC' as timestamp) as created_at,
    cast(updated_at at time zone 'UTC' as timestamp) as updated_at,
    cast(closed_at at time zone 'UTC' as timestamp) as closed_at,
    html_url
from deduplicated
where _row_rank = 1
