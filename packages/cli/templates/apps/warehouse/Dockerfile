# warehouse container (ADR-0004): the materialize toolchain — dlt (extraction) +
# dbt-duckdb (transform) + the duckdb CLI — baked onto Cloudflare's sandbox base image
# so the Worker can exec a one-shot materialize run via @cloudflare/sandbox. The base
# image's /container-server entrypoint MUST stay — do NOT add ENTRYPOINT/CMD.
FROM docker.io/cloudflare/sandbox:0.12.1

# python3 + pip: the base image has none (Ubuntu 22.04/jammy). unzip: needed to unpack
# the duckdb CLI release below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip unzip \
  && rm -rf /var/lib/apt/lists/*

# uv: fast, reproducible Python package installer for the dbt/dlt toolchain below.
# Pinned release so a cold rebuild can't silently pick up a breaking uv version.
RUN wget -nv -O /tmp/uv-installer.sh https://astral.sh/uv/0.5.11/install.sh \
  && sh /tmp/uv-installer.sh \
  && rm /tmp/uv-installer.sh \
  && mv /root/.local/bin/uv /root/.local/bin/uvx /usr/local/bin/
ENV PATH="/usr/local/bin:${PATH}"

# duckdb + dbt-duckdb + dlt, ALL THREE pinned together — an unpinned dbt-duckdb/dlt next
# to a pinned duckdb is the fragile combination: a rebuild months from now would resolve
# the unpinned two to whatever's current, which may demand a duckdb version the pin
# forbids. Bump all three together, deliberately. `--system` installs onto the image's
# python3 directly (no venv) — this container runs exactly one job at a time (the
# materialize run), so there's no dependency-isolation need a venv would buy.
RUN uv pip install --system --no-cache duckdb==1.5.5 dbt-duckdb==1.10.1 dlt==1.29.1

# duckdb CLI, pinned to the SAME version as the python `duckdb` package above so the CLI
# and the Python bindings read/write the identical on-disk/parquet format.
RUN ARCH=$(dpkg --print-architecture) \
  && case "$ARCH" in \
       amd64) DUCKDB_ARCH=linux-amd64 ;; \
       arm64) DUCKDB_ARCH=linux-arm64 ;; \
       *) echo "unsupported arch: $ARCH" >&2 && exit 1 ;; \
     esac \
  && wget -nv -O /tmp/duckdb.zip "https://github.com/duckdb/duckdb/releases/download/v1.5.5/duckdb_cli-${DUCKDB_ARCH}.zip" \
  && unzip -o /tmp/duckdb.zip -d /usr/local/bin \
  && rm /tmp/duckdb.zip \
  && chmod +x /usr/local/bin/duckdb

# Bake the package. `bun` ships in the base image, so no runtime install needed — only
# the app's own deps (zod for the mart contract, @cloudflare/sandbox, hyparquet) matter,
# and only container/ + the Python connectors/dbt project run in here (worker/ is the
# edge half, never baked into this image).
WORKDIR /app
COPY package.json bun.lock* tsconfig.json ./
RUN bun install --frozen-lockfile || bun install
COPY container container
COPY connectors connectors
COPY dbt dbt
