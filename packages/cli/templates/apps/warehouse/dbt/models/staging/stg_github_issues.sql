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
    cast(created_at as timestamp) as created_at,
    cast(updated_at as timestamp) as updated_at,
    cast(closed_at as timestamp) as closed_at,
    html_url
from read_parquet('{{ env_var("WAREHOUSE_RAW_DIR", "./raw") }}/github/issues/*.parquet')
