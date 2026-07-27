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
    owner = os.environ["GITHUB_OWNER"]
    repo = os.environ["GITHUB_REPO"]
    token = os.environ.get("GITHUB_TOKEN")

    config: RESTAPIConfig = {
        "client": {
            "base_url": "https://api.github.com",
            "headers": {
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            # GitHub paginates list endpoints via the standard RFC 5988 Link header.
            "paginator": "header_link",
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
    pipeline = dlt.pipeline(
        pipeline_name="github",
        destination=dlt.destinations.filesystem(bucket_url=f"file://{os.path.abspath(RAW_DIR)}"),
        dataset_name="github",
    )
    load_info = pipeline.run(github_issues_source(), loader_file_format="parquet")
    print(load_info)


if __name__ == "__main__":
    run()
