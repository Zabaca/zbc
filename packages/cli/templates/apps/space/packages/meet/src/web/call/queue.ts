// A first-in-first-out queue, one per peer connection. Cloudflare refuses a
// request to a session while an earlier renegotiation on it is still open (a
// 406), so each queued job runs the whole exchange, including applying the
// SFU's offer and sending back the answer, and the next job does not start
// until that job has finished or failed. A failed job does not stop the queue.

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private pending = 0

  /** Run `job` after every job queued before it has settled. Resolves or rejects with the job's own result. */
  run<T>(job: () => Promise<T>): Promise<T> {
    this.pending++
    const result = this.tail.then(job, job)
    this.tail = result.then(
      () => {
        this.pending--
      },
      () => {
        this.pending--
      },
    )
    return result
  }

  /** Jobs queued or running. */
  get size(): number {
    return this.pending
  }

  /** Resolves when everything queued so far has settled. */
  idle(): Promise<void> {
    return this.tail.then(() => undefined)
  }
}
