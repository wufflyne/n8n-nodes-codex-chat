import { createHash } from "node:crypto";

export function wireName(name: string): string {
  // Stable across tool rounds and process restarts; the current registry provides the inverse.
  return /^[A-Za-z0-9_-]{1,64}$/.test(name)
    ? name
    : `n8n_${createHash("sha256").update(name).digest("hex").slice(0, 48)}`;
}
