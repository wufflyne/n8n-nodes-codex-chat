import { createHash } from "node:crypto";
import { assert } from "./errors.js";
import type { Identity, Session } from "./types.js";
/** Verified account equality, independent of profile aliases and rotating credentials. */
export function accountIdentityKey(identity: Identity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([identity.issuer, identity.clientId, identity.accountId]),
    )
    .digest("hex");
}
export interface ExecutionContext {
  instanceId: string;
  workflowId: string;
  executionId: string;
  nodeId: string;
  nodeName: string;
}
export interface AffinityPolicy {
  mode: "execution" | "conversation" | "none";
  conversationKey?: string;
}
export function executionKey(c: ExecutionContext): string {
  return createHash("sha256")
    .update(JSON.stringify([c.instanceId, c.workflowId, c.executionId]))
    .digest("hex");
}
export function affinityKey(
  c: ExecutionContext | undefined,
  session: Session,
  model: string,
  wire: string,
  policy: AffinityPolicy = { mode: "execution" },
): string | undefined {
  if (policy.mode === "none" || !c) return undefined;
  assert(
    ["execution", "conversation"].includes(policy.mode),
    "Choose a supported prompt affinity mode.",
  );
  const value =
    policy.mode === "execution" ? c.executionId : policy.conversationKey;
  assert(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 1024 &&
      !/[\x00-\x1f\x7f]/.test(value),
    "Provide a bounded nonempty Conversation Key.",
  );
  return createHash("sha256")
    .update(
      JSON.stringify([
        "codex-wire-cache-v1",
        c.instanceId,
        c.workflowId,
        c.nodeId,
        session.affinity,
        model,
        wire,
        policy.mode,
        value,
      ]),
    )
    .digest("hex");
}
