import { assert } from "../core/errors.js";
export type OwnerLock = <T>(name: string, action: () => Promise<T>) => Promise<T>;
/** Used only while the separate OS-backed owner lease excludes every other process. */
export function nativeLocks(): OwnerLock {
  const tails = new Map<string, Promise<unknown>>();
  let queued = 0;
  return async (name, action) => {
    assert(
      queued < 256,
      "Codex Wire's local operation queue is full. Retry after active operations finish.",
    );
    queued++;
    const next = (tails.get(name) ?? Promise.resolve()).catch(() => undefined).then(action);
    tails.set(name, next);
    try {
      return await next;
    } finally {
      queued--;
      if (tails.get(name) === next) tails.delete(name);
    }
  };
}
