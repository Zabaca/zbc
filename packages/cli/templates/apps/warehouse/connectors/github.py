"""The one reference connector shipped by the warehouse app template (ADR-0004): a dlt
source that lands one repo's GitHub issues as raw parquet for dbt to read.

Runs one-shot inside a materialize invocation (never on the Worker's general runtime —
CONTEXT.md "Connector"). Reads its target and credential from the environment:

  GITHUB_OWNER  repo owner (org or user), required
  GITHUB_REPO   repo name, required
  GITHUB_TOKEN  fine-grained PAT with read-only repo access; optional locally (public
                repos work unauthenticated at a low rate limit) but required in the
                container's materialize run to avoid GitHub's anonymous rate limit

Landing is DURABLE: this file writes parquet through dlt's filesystem destination straight
to R2 (`s3://<bucket>/raw`, via WAREHOUSE_RAW_URL — resolved by container/materialize.ts and
injected, never re-derived here), using the S3-compatible credentials the Worker forwards.
That durability is what makes the run below incremental: dlt persists its cursor to
_dlt_pipeline_state at the destination and restores it on the next cold container. Publishing
*marts* remains the orchestrator's job; this file only lands raw.

Resource choice: repo issues, not repos. A single repo's issue list is small (this
connector's whole point per ADR-0004 is "framework + one working connector", not a
connector library) but has enough rows and real pagination to be a meaningful smoke
test of dlt's REST API source, and it's the natural input for the shipped
mart_github_issues mart.
"""

from __future__ import annotations

import os

import dlt
from dlt.sources.helpers.requests import Client
from dlt.sources.helpers.rest_client.auth import BearerTokenAuth
from dlt.sources.rest_api import RESTAPIConfig, rest_api_source

RAW_DIR = os.environ.get("WAREHOUSE_RAW_DIR", "./raw")

# Where the raw layer lives. container/materialize.ts resolves this ONCE and injects it into
# both this step and the dbt step, so the two cannot drift apart (see resolveRawUrl there).
# Standalone runs on a laptop fall back to a local directory — that path has no durable state
# and therefore re-extracts in full every time, which is the right behaviour for development.
RAW_URL = os.environ.get("WAREHOUSE_RAW_URL") or f"file://{os.path.abspath(RAW_DIR)}"

# The very first run has no cursor to resume from, so it needs a floor meaning "everything".
#
# DO NOT set this to the Unix epoch. Measured against the live API (2026-07-27):
#
#   since=1969-12-31T00:00:00Z -> 0 issues
#   since=1970-01-01T00:00:00Z -> 0 issues     <- the obvious choice, and it returns NOTHING
#   since=1971-01-01T00:00:00Z -> 18 issues
#
# GitHub answers 200 with an empty array for a `since` at or before the epoch rather than
# erroring, so the natural spelling of "give me everything" silently means "give me nothing",
# and it fails in the one place nobody looks: the very first run of a brand-new pipeline, when
# an empty result is indistinguishable from a repo that simply has no issues yet. (This cost a
# full debugging cycle here — the run reported success, dlt reported "0 load packages", and the
# mart published 0 rows, because the empty-table bootstrap below dutifully covered for it.)
#
# 2008 is the meaningful floor: GitHub itself launched in February 2008, so no issue in any
# repo can predate it, and it is nowhere near the epoch cliff.
INITIAL_SINCE = "2008-01-01T00:00:00Z"


def _r2_env() -> tuple[str, str, str]:
    """The R2 endpoint/key/secret for RAW_URL, or raise if the URL needs them and they're absent.

    R2 speaks the S3 API but is not AWS: it needs an explicit endpoint, and it has no regions
    (`auto` is the documented placeholder — the field still has to be populated for request
    signing). These are the same S3-compatible credentials the Worker derives from
    CLOUDFLARE_API_TOKEN and forwards into the container; this connector never mints or sees a
    Cloudflare API token itself.
    """
    endpoint = os.environ.get("WAREHOUSE_R2_ENDPOINT", "").strip()
    key = os.environ.get("WAREHOUSE_R2_ACCESS_KEY_ID", "").strip()
    secret = os.environ.get("WAREHOUSE_R2_SECRET_ACCESS_KEY", "").strip()
    if not (endpoint and key and secret):
        raise SystemExit(
            "connectors/github.py: WAREHOUSE_RAW_URL is an s3:// URL but the R2 credentials "
            "(WAREHOUSE_R2_ENDPOINT, WAREHOUSE_R2_ACCESS_KEY_ID, "
            "WAREHOUSE_R2_SECRET_ACCESS_KEY) are not all set."
        )
    return endpoint, key, secret


# The same three values have to be spelled two DIFFERENT ways, which is not redundancy and
# must not be "simplified" into one dict. dlt's filesystem destination binds credentials to
# its own `AwsCredentials` config class (aws_access_key_id / aws_secret_access_key /
# endpoint_url); fsspec's S3FileSystem — used directly for the empty-table bootstrap below —
# takes key / secret / client_kwargs.endpoint_url. Passing either shape to the other fails:
# dlt raises ConfigFieldMissingException for `aws_access_key_id` on an fsspec-shaped dict,
# because it does not read the alien keys at all.


def _dlt_credentials() -> dict:
    """Credentials in dlt's `AwsCredentials` shape, `{}` for a local RAW_URL."""
    if not RAW_URL.startswith("s3://"):
        return {}
    endpoint, key, secret = _r2_env()
    return {
        "aws_access_key_id": key,
        "aws_secret_access_key": secret,
        "endpoint_url": endpoint,
        "region_name": "auto",
    }


def _fsspec_storage_options() -> dict:
    """Credentials in fsspec's S3FileSystem shape, `{}` for a local RAW_URL."""
    if not RAW_URL.startswith("s3://"):
        return {}
    endpoint, key, secret = _r2_env()
    return {"key": key, "secret": secret, "client_kwargs": {"endpoint_url": endpoint}}


def github_issues_source() -> object:
    """A dlt source yielding one resource, `issues`: every issue (open + closed, PRs
    included — GitHub's API models a PR as an issue with a `pull_request` key) for the
    repo named by GITHUB_OWNER/GITHUB_REPO. Auth is a bearer PAT when GITHUB_TOKEN is
    set; unauthenticated otherwise (fine for public repos at GitHub's low anonymous
    rate limit — good enough for local/dev runs, not for a scheduled production job).
    """
    # `os.environ[...]` raises on an ABSENT key but happily returns an empty string for a
    # key that is present and blank — which is exactly what wrangler.jsonc's placeholder
    # vars produce. Unguarded, that builds the URL `repos///issues`, GitHub 404s, and dlt
    # raises a pipeline error that says nothing about configuration. container/connectors.ts
    # normally skips this connector before it ever runs; this guard covers a direct
    # invocation and makes the reason obvious either way.
    owner = os.environ.get("GITHUB_OWNER", "").strip()
    repo = os.environ.get("GITHUB_REPO", "").strip()
    if not owner or not repo:
        raise SystemExit(
            "connectors/github.py: GITHUB_OWNER and GITHUB_REPO must both be set and non-empty. "
            "Set them as workerVars on the warehouse instance, or remove this connector from "
            "container/connectors.ts if the project does not use it."
        )
    token = os.environ.get("GITHUB_TOKEN")

    config: RESTAPIConfig = {
        "client": {
            "base_url": "https://api.github.com",
            "headers": {
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            # GitHub paginates list endpoints via the standard RFC 5988 Link header. (It has
            # since moved this endpoint to cursor pagination — only `rel="next"`, no
            # `rel="last"` — which header_link follows correctly.)
            "paginator": "header_link",
            # dlt's DEFAULT retry set is (429, 5xx) — and GitHub signals PRIMARY rate-limit
            # exhaustion with **403**, not 429. So out of the box a rate-limited extract gets
            # ZERO retries and kills the whole materialize run on the first refusal; with no
            # incremental cursor, every page already fetched is discarded with it. This
            # session adds 403 and honours Retry-After / X-RateLimit-Reset instead of blind
            # exponential backoff. Retrying 403 is safe because this connector only issues
            # GETs — the worst case is re-reading a page.
            #
            # NOTE: this must be a `session`, not a `retry` key. RESTAPIConfig's ClientConfig
            # accepts only base_url/headers/auth/paginator/session — an unknown key is
            # silently ignored, which would leave the default retry set in place while
            # looking configured.
            "session": Client(
                status_codes=(403, 429, *range(500, 600)),
                request_max_attempts=5,
                respect_retry_after_header=True,
            ).session,
            **({"auth": BearerTokenAuth(token)} if token else {}),
        },
        "resources": [
            {
                "name": "issues",
                # APPEND, not replace — raw is now durable (docs/adr/0004), so each run adds
                # only what changed rather than rewriting the whole table. `replace` here
                # would delete every previously-landed file on each run, which would keep the
                # storage bill down and throw away the entire point of a raw layer: the
                # history you cannot re-fetch once the source API has moved on.
                #
                # The cost of append is duplicates: GitHub's `since` is INCLUSIVE, so the
                # boundary issue from the previous run comes back, and any issue touched
                # twice lands twice. That is correct for an append-only raw layer and is
                # resolved downstream — stg_github_issues.sql keeps the newest row per
                # issue_id. Do not "fix" it by switching to merge: the filesystem
                # destination silently falls back to append for merge anyway, so the dedup
                # would look configured and not be.
                "write_disposition": "append",
                "primary_key": "id",
                "endpoint": {
                    "path": f"repos/{owner}/{repo}/issues",
                    "params": {
                        "state": "all",
                        "per_page": 100,
                        # Ascending by update time so the cursor advances monotonically as
                        # pages are consumed; GitHub's default (created, desc) would make the
                        # last page the OLDEST and a mid-run failure would strand the cursor
                        # ahead of data that was never landed.
                        "sort": "updated",
                        "direction": "asc",
                        # The incremental cursor itself. dlt tracks max(updated_at) across
                        # runs, persists it to _dlt_pipeline_state at the destination, and
                        # feeds it back as `?since=` on the next run — which is only durable
                        # because that destination is R2 rather than the container's disk.
                        "since": {
                            "type": "incremental",
                            "cursor_path": "updated_at",
                            "initial_value": INITIAL_SINCE,
                        },
                    },
                },
            },
        ],
    }
    return rest_api_source(config)


def run() -> None:
    # dlt retains every completed load package under its pipelines dir forever, and each one
    # holds a full SECOND copy of that run's parquet. On a long-lived container instance with
    # a daily cron that grows without bound against a disk measured in single-digit GB —
    # roughly 2x the extract size per run. Nothing here needs load history: raw is
    # container-local and discarded anyway (docs/adr/0004), and marts are the durable output.
    os.environ.setdefault("LOAD__DELETE_COMPLETED_JOBS", "true")

    # dlt keeps every state file ever written under _dlt_pipeline_state and reads the latest.
    # The default cap is 100; pinning it makes the bound explicit rather than inherited, since
    # this is now durable storage that nothing else prunes. Only the newest is ever used — the
    # rest are history for `dlt pipeline ... sync` and debugging.
    os.environ.setdefault("DESTINATION__FILESYSTEM__MAX_STATE_FILES", "50")

    # dlt's parquet normalizer omits _dlt_load_id by default (verified against the installed
    # dlt: NormalizeConfiguration.parquet_normalizer defaults add_dlt_load_id=False, unlike
    # the model normalizer which defaults it True). The staging model needs it as the
    # tiebreak when the same issue lands twice with an identical updated_at — without it,
    # dedup falls back to whatever order read_parquet happens to return, which is file order
    # and therefore not stable across runs.
    os.environ.setdefault("NORMALIZE__PARQUET_NORMALIZER__ADD_DLT_LOAD_ID", "true")

    pipeline = dlt.pipeline(
        pipeline_name="github",
        destination=dlt.destinations.filesystem(
            bucket_url=RAW_URL,
            credentials=_dlt_credentials() or None,
        ),
        dataset_name="github",
    )
    # pipeline.run() calls sync_destination() first, which restores incremental state from
    # _dlt_pipeline_state at the destination whenever the local working directory is empty —
    # i.e. on every cold container. That restore is the entire mechanism behind incremental
    # extraction here; without a durable destination there is nothing to restore FROM, and
    # each run silently re-extracts everything while still looking like it worked.
    load_info = pipeline.run(github_issues_source(), loader_file_format="parquet")
    print(load_info)
    _ensure_issues_table_exists()


# The column set (and exact arrow types) the staging model reads. Timestamps are tz-aware to
# match what dlt writes for a non-empty load — the mart's declared TIMESTAMP type flows from
# this through `cast(... at time zone 'UTC' as timestamp)`, and materialize.ts verifies the
# produced parquet against schema.yml, so an empty run must produce the SAME types a
# populated run does or it would fail that check instead.
_ISSUES_SCHEMA_FIELDS = [
    ("id", "int64"),
    ("number", "int64"),
    ("title", "string"),
    ("state", "string"),
    ("user__login", "string"),
    ("comments", "int64"),
    ("pull_request__url", "string"),
    ("created_at", "timestamp"),
    ("updated_at", "timestamp"),
    ("closed_at", "timestamp"),
    ("html_url", "string"),
]


def _ensure_issues_table_exists() -> None:
    """Write an empty, correctly-typed issues parquet when the repo has no issues at all.

    dlt's filesystem destination only materializes a table it actually saw rows for, so a
    repo with zero issues produces `_dlt_loads`/`_dlt_version`/`_dlt_pipeline_state` and no
    `issues/` directory. The staging model then dies on
    `read_parquet('.../issues/*.parquet')` with "No files found that match the pattern",
    failing the entire materialize run — for what is a perfectly legitimate state (a new or
    quiet repo). Column hints on the resource do NOT fix this; the directory is simply never
    created. So create it, with the schema a populated run would have produced, and let the
    mart correctly come out at 0 rows.
    """
    import fsspec
    import pyarrow as pa
    import pyarrow.parquet as pq

    # url_to_fs resolves BOTH backends the raw layer supports — s3fs for the durable R2 case,
    # LocalFileSystem for the standalone-development case — so this stays one code path.
    fs, base = fsspec.core.url_to_fs(RAW_URL, **_fsspec_storage_options())
    issues_dir = f"{base.rstrip('/')}/github/issues"
    if fs.glob(f"{issues_dir}/*.parquet"):
        return

    fs.makedirs(issues_dir, exist_ok=True)
    timestamp_type = pa.timestamp("us", tz="UTC")
    schema = pa.schema(
        [
            pa.field(name, timestamp_type if kind == "timestamp" else getattr(pa, kind)())
            for name, kind in _ISSUES_SCHEMA_FIELDS
        ]
    )
    with fs.open(f"{issues_dir}/empty.parquet", "wb") as handle:
        pq.write_table(schema.empty_table(), handle)
    print(f"connectors/github.py: no issues found — wrote an empty typed table to {issues_dir}")


if __name__ == "__main__":
    run()
