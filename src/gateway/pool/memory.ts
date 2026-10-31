import { WireError } from "../errors.js";
import type { PendingAdmissionBudget } from "./admission.js";

export interface MemoryLease {
  (): void;
  readonly bytes: number;
  tryExtend(bytes: number): MemoryLease;
}
/** Wait only before ingress reads; an already admitted request never waits for an upgrade. */
export class BodyMemoryAdmission {
  private reserved = 0;
  private waiters = new Set<() => void>();
  constructor(
    readonly budget = 192 * 1024 * 1024,
    readonly maximumWaiters = 64,
    readonly waitMs = 10000,
  ) {}
  async acquire(
    contentLength: number | undefined,
    signal?: AbortSignal,
    pending?: PendingAdmissionBudget,
  ) {
    if (
      contentLength !== undefined &&
      (!Number.isSafeInteger(contentLength) ||
        contentLength < 0 ||
        contentLength > 32 * 1024 * 1024)
    )
      throw new WireError(413, "request_too_large", "The request exceeds its body limit.");
    return this.acquireBytes(32 * 1024 * 1024 + 4 * (contentLength ?? 32 * 1024 * 1024), signal, pending);
  }
  async acquireRequest(
    method: string,
    contentLength: number | undefined,
    transferEncoding: boolean,
    signal?: AbortSignal,
    pending?: PendingAdmissionBudget,
  ) {
    if (method === "GET" || method === "HEAD") {
      if (transferEncoding || (contentLength !== undefined && contentLength !== 0))
        throw new WireError(400, "unexpected_body", "GET and HEAD requests cannot include a body.");
      return this.acquireBytes(8 * 1024 * 1024, signal, pending);
    }
    return this.acquire(contentLength, signal, pending);
  }
  private valid(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.budget)
      throw new WireError(
        413,
        "request_memory_limit",
        "This request cannot fit within the gateway memory limit.",
      );
  }
  private lease(bytes: number, group = { total: 0 }): MemoryLease {
    this.reserved += bytes;
    group.total += bytes;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.reserved -= bytes;
      group.total -= bytes;
      for (const wake of this.waiters) wake();
    };
    return Object.defineProperties(release, {
      bytes: { get: () => group.total },
      tryExtend: {
        value: (extra: number) => {
          if (released)
            throw new WireError(
              422,
              "cancelled",
              "The request has already released its memory reservation.",
            );
          this.valid(extra);
          this.valid(group.total + extra);
          if (this.reserved + extra > this.budget)
            throw new WireError(
              429,
              "memory_capacity",
              "The expanded request cannot be admitted while other requests hold memory. No generation was dispatched.",
            );
          return this.lease(extra, group);
        },
      },
    }) as MemoryLease;
  }
  tryAcquireBytes(bytes: number) {
    this.valid(bytes);
    if (this.reserved + bytes > this.budget)
      throw new WireError(
        429,
        "memory_capacity",
        "Gateway memory capacity is occupied. No generation was dispatched.",
      );
    return this.lease(bytes);
  }
  async acquireBytes(
    reservation: number,
    signal?: AbortSignal,
    pending?: PendingAdmissionBudget,
  ): Promise<MemoryLease> {
    this.valid(reservation);
    const deadline = Date.now() + Math.min(this.waitMs, pending?.waitMs ?? this.waitMs);
    while (this.reserved + reservation > this.budget) {
      if (signal?.aborted)
        throw new WireError(
          422,
          "cancelled",
          "The request was cancelled before its body was admitted.",
        );
      const releasePending =
        this.waiters.size < this.maximumWaiters && Date.now() < deadline
          ? pending ? pending.tryAcquire() : () => {}
          : undefined;
      if (!releasePending)
        throw new WireError(
          429,
          "memory_queue_full",
          "The gateway body queue is full; no request was admitted.",
        );
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: WireError) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          this.waiters.delete(wake);
          releasePending();
          if (error) reject(error);
          else resolve();
        };
        const wake = () => finish();
        const abort = () => {
          finish(
            new WireError(
              422,
              "cancelled",
              "The request was cancelled before its body was admitted.",
            ),
          );
        };
        const timer = setTimeout(wake, deadline - Date.now());
        this.waiters.add(wake);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (signal?.aborted)
      throw new WireError(
        422,
        "cancelled",
        "The request was cancelled before its body was admitted.",
      );
    return this.lease(reservation);
  }
  get reservedBytes() {
    return this.reserved;
  }
  get queuedRequests() {
    return this.waiters.size;
  }
}
export const gatewayMemory = new BodyMemoryAdmission(320 * 1024 * 1024);
export const requestMemory = new WeakMap<Request, MemoryLease>();
