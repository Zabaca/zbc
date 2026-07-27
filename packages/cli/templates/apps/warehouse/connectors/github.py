"""The one reference connector shipped by the warehouse app template (ADR-0004): a dlt
source that lands one repo's GitHub issues as raw parquet under ./raw for dbt to read.

Runs one-shot inside a materialize invocation (never on the Worker's general runtime —
CONTEXT.md "Connector"). Reads its target and credential from the environment:

  GITHUB_OWNER  repo owner (org or user), required
  GITHUB_REPO   repo name, required
  GITHUB_TOKEN  fine-grained PAT with read-only repo access; optional locally (public
                repos work unauthenticated at a low rate limit) but required in the
                container's materialize run to avoid GitHub's anonymous rate limit

Landing is local-to-the-container-run: this file writes parquet to a local directory
(default ./raw) via dlt's filesystem destination. Uploading raw/marts to R2 is the
container-side orchestrator's job (container/materialize.ts, a separate slice of
ADR-0004) — this file does not talk to R2 or any Cloudflare API.

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
                "write_disposition": "replace",
                "endpoint": {
                    "path": f"repos/{owner}/{repo}/issues",
                    "params": {
                        "state": "all",
                        "per_page": 100,
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

    pipeline = dlt.pipeline(
        pipeline_name="github",
        destination=dlt.destinations.filesystem(bucket_url=f"file://{os.path.abspath(RAW_DIR)}"),
        dataset_name="github",
    )
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
    import glob

    import pyarrow as pa
    import pyarrow.parquet as pq

    issues_dir = os.path.join(os.path.abspath(RAW_DIR), "github", "issues")
    if glob.glob(os.path.join(issues_dir, "*.parquet")):
        return

    os.makedirs(issues_dir, exist_ok=True)
    timestamp_type = pa.timestamp("us", tz="UTC")
    schema = pa.schema(
        [
            pa.field(name, timestamp_type if kind == "timestamp" else getattr(pa, kind)())
            for name, kind in _ISSUES_SCHEMA_FIELDS
        ]
    )
    pq.write_table(schema.empty_table(), os.path.join(issues_dir, "empty.parquet"))
    print(f"connectors/github.py: no issues found — wrote an empty typed table to {issues_dir}")


if __name__ == "__main__":
    run()
