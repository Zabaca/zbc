-- Raw-to-typed reshaping of what connectors/github.py landed: dlt's REST API source
-- writes every field GitHub's issues endpoint returns (100+ columns, nested objects
-- flattened with `__` by dlt's normalizer, e.g. `user__login`) — this model narrows
-- that down to the columns the mart actually needs and gives them mart-facing names.
--
-- WAREHOUSE_RAW_DIR must match the same env var (and default) the connector lands to,
-- so a materialize run's dbt step reads exactly what its own dlt step just wrote.
--
-- GitHub's REST API models a pull request as an issue with a non-null `pull_request`
-- field — `is_pull_request` makes that explicit instead of leaving it an implicit
-- artifact of the source API a mart consumer would have to know to check for.

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
from read_parquet('{{ env_var("WAREHOUSE_RAW_DIR", "./raw") }}/github/issues/*.parquet')
