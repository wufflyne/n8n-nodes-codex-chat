import { assert } from "./errors.js";
/** Preserve insertion order and semantic JSON exactly; reject classes, cycles and executable values. */
export function jsonSnapshot<T>(value: T, maxBytes = 65536, maxDepth = 32): T {
  const active = new Set<object>();
  function visit(v: unknown, depth: number): unknown {
    assert(depth <= maxDepth, "The JSON schema exceeds its depth limit.");
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      assert(
        Number.isFinite(v),
        "JSON configuration must contain finite numbers.",
      );
      return v;
    }
    assert(
      typeof v === "object",
      "JSON configuration contains a non-JSON value.",
    );
    assert(!active.has(v as object), "JSON configuration must be acyclic.");
    active.add(v as object);
    let result: unknown;
    if (Array.isArray(v)) result = v.map((x) => visit(x, depth + 1));
    else {
      assert(
        Object.getPrototypeOf(v) === Object.prototype ||
          Object.getPrototypeOf(v) === null,
        "JSON configuration must contain plain objects.",
      );
      result = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          k,
          visit(x, depth + 1),
        ]),
      );
    }
    active.delete(v as object);
    return Object.freeze(result);
  }
  const result = visit(value, 0) as T;
  assert(
    Buffer.byteLength(JSON.stringify(result)) <= maxBytes,
    "The JSON schema exceeds its size limit.",
  );
  return result;
}
