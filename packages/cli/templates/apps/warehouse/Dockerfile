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

# Pin the container's clock to UTC. dlt lands timestamps as TIMESTAMP WITH TIME ZONE, and
# DuckDB's cast-to-TIMESTAMP resolves against the SESSION time zone — so whatever TZ this
# image happens to carry silently rewrites every timestamp in every mart, while the column
# names, types, and schema checks all still pass. The dbt models pin `at time zone 'UTC'`
# explicitly and the Worker blocks TZ from crossing in; this is the third layer, and it also
# covers anyone running the pipeline in this image by hand.
ENV TZ=UTC

# duckdb + dbt-duckdb + dlt, ALL THREE pinned together — an unpinned dbt-duckdb/dlt next
# to a pinned duckdb is the fragile combination: a rebuild months from now would resolve
# the unpinned two to whatever's current, which may demand a duckdb version the pin
# forbids. Bump all three together, deliberately. `--system` installs onto the image's
# python3 directly (no venv) — this container runs exactly one job at a time (the
# materialize run), so there's no dependency-isolation need a venv would buy. dlt's
# `[parquet]` extra pulls in pyarrow, which its filesystem destination needs to write
# parquet at all — a plain `dlt==` install resolves without it and fails at runtime
# (ModuleNotFoundError: pyarrow) the first time a connector actually lands data.
# The `s3` extra brings s3fs/fsspec — without it dlt's filesystem destination cannot address
# an s3:// bucket_url at all, which is how the durable raw layer (docs/adr/0004) reaches R2.
RUN uv pip install --system --no-cache duckdb==1.5.5 dbt-duckdb==1.10.1 "dlt[parquet,s3]==1.29.1"

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
# Gated multiprocessing-lock workaround, active only when WAREHOUSE_PATCH_MP_LOCKS=1
# (site-packages sitecustomize.py convention)
# — see container/sitecustomize.py's header for why: production Containers run on
# Firecracker microVMs with no working /dev/shm, which dbt-core's hardcoded
# multiprocessing.RLock() call needs and has no config override to avoid. APPENDED to
# (not placed alongside) the base image's own /usr/lib/python3.10/sitecustomize.py
# (an apport crash-hook installer, harmless to keep): sys.path resolves that path
# BEFORE /usr/local/lib/python3.10/dist-packages, so Python imports the FIRST
# sitecustomize.py it finds and never reaches a second one placed later on the path —
# verified the hard way, a copy into dist-packages silently never loaded.
COPY container/sitecustomize.py /tmp/warehouse-sitecustomize.py
RUN cat /tmp/warehouse-sitecustomize.py >> /usr/lib/python3.10/sitecustomize.py \
  && rm /tmp/warehouse-sitecustomize.py

WORKDIR /app
COPY package.json bun.lock* tsconfig.json ./
RUN bun install --frozen-lockfile || bun install
COPY container container
COPY connectors connectors
COPY dbt dbt
# shared/ is the cross-runtime contract (mart schema + R2 key layout) — a whole directory
# that EXISTS to be imported by both runtimes, so copying it wholesale is safe. This
# replaces cherry-picking two individual files out of worker/, which was fragile in a way
# that only showed up at runtime: worker/index.ts statically imports '@cloudflare/sandbox'
# (fatal in a plain Bun process), so the moment anyone added a third container→worker import
# the image would build fine and then die on `bun run container/materialize.ts`.
COPY shared shared
