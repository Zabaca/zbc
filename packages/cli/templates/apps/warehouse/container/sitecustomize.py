# Auto-imported by every python3 invocation in this image, but ONLY ACTS when
# WAREHOUSE_PATCH_MP_LOCKS=1 is set in the environment — container/materialize.ts sets it on
# the `dbt` invocation and nothing else. See the Dockerfile for how this file is installed
# (it is APPENDED to the base image's own /usr/lib/python3.10/sitecustomize.py, because
# Python imports only the FIRST sitecustomize.py on sys.path).
#
# Why gated rather than global: the patch below is safe for dbt and NOT safe in general.
# dbt never creates a real OS process — every mp_context consumer in dbt-core/dbt-adapters/
# dbt-duckdb manufactures a Lock/RLock used purely for cross-THREAD synchronization within
# one process (its `threads:` setting is a multiprocessing.pool.ThreadPool, i.e. real
# threads), so swapping in a threading lock loses only a process-shared guarantee dbt never
# exercises. dlt is different: its normalize step defaults to pool_type="process" and builds
# a genuine ProcessPoolExecutor, and a threading.RLock is not picklable — under a global
# patch that fails with "TypeError: cannot pickle '_thread.RLock' object". That failure is
# at least LOUD rather than silently unsynchronized, but there is no reason to expose dlt to
# it: dlt runs unpatched, and materialize.ts pins it to a single worker so it never needs a
# process pool in the first place.
#
# Cloudflare's production Containers run on Firecracker microVMs (confirmed via
# `wrangler containers info` reporting runtime: "firecracker"), which do not provide a
# working /dev/shm — every
# POSIX-semaphore-backed multiprocessing primitive (RLock/Lock/Semaphore) raises
# `FileNotFoundError: [Errno 2] No such file or directory` the instant one is
# constructed. dbt-core hits this unconditionally at startup: dbt/mp_context.py
# hardcodes `multiprocessing.get_context("spawn")` with no config override, and
# dbt/adapters/base/connections.py's ConnectionManager.__init__ calls
# `mp_context.RLock()` before running a single model. Reproduced locally under plain
# Docker and `wrangler dev` (both work fine — /dev/shm is present there), so this is
# specific to the real production runtime, not the image.
#
# dbt's own "threads" (profiles.yml's `threads: 4`) are a ThreadPoolExecutor — genuine
# in-process threads, never a real multiprocessing.Process — so this container never
# does real cross-process work that would need a POSIX-shared primitive. Swapping the
# multiprocessing context's RLock/Lock/Semaphore for threading-backed equivalents is
# safe here and sidesteps the missing /dev/shm entirely rather than trying to work
# around a platform constraint we don't control.
import os
import threading
import multiprocessing.context as _mp_context


class _ThreadBackedLock:
    """Duck-types multiprocessing's Lock/RLock (acquire/release/context-manager),
    backed by a real threading.RLock instead of a POSIX named semaphore."""

    def __init__(self, *_args, **_kwargs):
        self._lock = threading.RLock()

    def acquire(self, *args, **kwargs):
        return self._lock.acquire(*args, **kwargs)

    def release(self):
        return self._lock.release()

    def __enter__(self):
        return self._lock.__enter__()

    def __exit__(self, *args):
        return self._lock.__exit__(*args)


def _patched_lock(self, *args, **kwargs):
    return _ThreadBackedLock()


if os.environ.get("WAREHOUSE_PATCH_MP_LOCKS") == "1":
    _mp_context.BaseContext.RLock = _patched_lock
    _mp_context.BaseContext.Lock = _patched_lock
