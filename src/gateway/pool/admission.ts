import { WireError } from "../errors.js";

/** One application's body and model waiters share its configured pending limit. */
export class PendingAdmissionBudget {
  private pending = 0;
  constructor(
    readonly maximum: number,
    readonly waitMs: number,
  ) {}
  tryAcquire(): (() => void) | undefined {
    if (this.pending >= this.maximum) return;
    this.pending++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pending--;
    };
  }
  get count() {
    return this.pending;
  }
}

export class AdmissionQueue {
  private active = 0;
  private readonly accounts = new Map<string, number>();
  private readonly branches = new Set<string>();
  private readonly waiting = new Set<() => void>();
  private draining = false;
  readonly pending: PendingAdmissionBudget;
  constructor(readonly limits = { active: 8, account: 2, queued: 64, waitMs: 10000 }) {
    this.pending = new PendingAdmissionBudget(limits.queued, limits.waitMs);
  }
  async acquire(account: string, branch: string | null, signal?: AbortSignal): Promise<() => void> {
    const deadline = Date.now() + this.limits.waitMs;
    while (true) {
      if (signal?.aborted)
        throw new WireError(422, "cancelled", "The request was cancelled before admission.");
      if (this.draining)
        throw new WireError(503, "draining", "The gateway is draining; no request was admitted.");
      if (
        this.active < this.limits.active &&
        (this.accounts.get(account) ?? 0) < this.limits.account &&
        (!branch || !this.branches.has(branch))
      ) {
        this.active++;
        this.accounts.set(account, (this.accounts.get(account) ?? 0) + 1);
        if (branch) this.branches.add(branch);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.active--;
          const n = (this.accounts.get(account) ?? 1) - 1;
          if (n) this.accounts.set(account, n);
          else this.accounts.delete(account);
          if (branch) this.branches.delete(branch);
          for (const wake of this.waiting) wake();
        };
      }
      const releasePending =
        this.waiting.size < this.limits.queued && Date.now() < deadline
          ? this.pending.tryAcquire()
          : undefined;
      if (!releasePending)
        throw new WireError(
          429,
          "queue_full",
          "The admission queue is full or its wait deadline expired; no request was admitted.",
        );
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: WireError) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          this.waiting.delete(wake);
          releasePending();
          if (error) reject(error);
          else resolve();
        };
        const wake = () => finish();
        const abort = () => {
          finish(new WireError(422, "cancelled", "The request was cancelled before admission."));
        };
        const timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
        this.waiting.add(wake);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
  drain() {
    this.draining = true;
    for (const wake of this.waiting) wake();
  }
  get activeCount() {
    return this.active;
  }
}
