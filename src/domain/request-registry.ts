export type RequestOutcome<T> =
  { status: 'resolved'; value: T } | { status: 'timed-out' } | { status: 'cancelled' }

interface PendingRequest<T> {
  timer: ReturnType<typeof setTimeout>
  settle: (outcome: RequestOutcome<T>) => void
}

export class RequestRegistry<T> {
  private readonly pending = new Map<string, PendingRequest<T>>()

  constructor(
    private readonly timeoutMs: number,
    private readonly onTimeout?: (requestId: string) => void,
  ) {}

  wait(requestId: string): Promise<RequestOutcome<T>> {
    this.cancel(requestId)
    return new Promise((settle) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return
        this.onTimeout?.(requestId)
        settle({ status: 'timed-out' })
      }, this.timeoutMs)
      this.pending.set(requestId, { timer, settle })
    })
  }

  resolve(requestId: string, value: T): boolean {
    const request = this.pending.get(requestId)
    if (!request) return false
    this.pending.delete(requestId)
    clearTimeout(request.timer)
    request.settle({ status: 'resolved', value })
    return true
  }

  cancel(requestId: string): boolean {
    const request = this.pending.get(requestId)
    if (!request) return false
    this.pending.delete(requestId)
    clearTimeout(request.timer)
    request.settle({ status: 'cancelled' })
    return true
  }

  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) this.cancel(requestId)
  }

  get size(): number {
    return this.pending.size
  }
}
