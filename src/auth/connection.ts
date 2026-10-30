import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { assert, CodexError } from "../core/errors.js";
import type { Binding } from "../core/types.js";
const delivered = new WeakSet<object>();
export interface DurableBinding {
  readonly binding: Readonly<Binding>;
}
/** A proof exists only after this module has exclusively written and synced the complete binding. */
export async function deliverBinding(
  filename: string,
  binding: Binding,
): Promise<DurableBinding> {
  let file;
  try {
    const parent = path.dirname(path.resolve(filename)),
      stat = await lstat(parent);
    assert(
      stat.isDirectory() &&
        (stat.mode & 0o077) === 0 &&
        (await realpath(parent)) === parent,
      "Use a private parent directory without symbolic-link components.",
    );
    file = await open(filename, "wx", 0o600);
    await file.writeFile(JSON.stringify(binding, null, 2) + "\n");
    await file.sync();
    await file.close();
    file = undefined;
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    const proof = Object.freeze({ binding: Object.freeze({ ...binding }) });
    delivered.add(proof);
    return proof;
  } catch {
    throw new CodexError(
      "storage",
      "The complete protected binding could not be delivered durably. No profile was activated.",
    );
  } finally {
    await file?.close().catch(() => undefined);
  }
}
export function verifyDelivery(proof: DurableBinding, binding: Binding): void {
  assert(
    delivered.has(proof) &&
      proof.binding.profileId === binding.profileId &&
      proof.binding.bindingSecret === binding.bindingSecret,
    "Profile activation requires an already durable binding.",
  );
}
