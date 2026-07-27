# Auto-imported by every python3 invocation in this image (any dir on sys.path named
# sitecustomize.py runs at interpreter startup, before user code — see the Dockerfile,
# which installs this into site-packages).
#
# Cloudflare's production Containers run on Firecracker microVMs (confirmed via
# `wrangler containers info`), which do not provide a working /dev/shm — every
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


_mp_context.BaseContext.RLock = _patched_lock
_mp_context.BaseContext.Lock = _patched_lock
