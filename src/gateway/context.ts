import { createHmac, timingSafeEqual } from "node:crypto";
import { invalid, terminal, WireError } from "./errors.js";

export interface ModelRequestContext {
  version: 1;
  installationId: string;
  projectId: string;
  agentRevision: string;
  conversationId: string;
  branchId: string;
  runId: string;
  turnId: string;
  operationId: string;
  operationIssuedAt: number;
  kind: "turn" | "title" | "helper" | "subagent" | "compaction";
  cause?: "generation" | "empty_turn_retry" | "regeneration";
  parentOperationId?: string;
}
export const OPERATION_WINDOW = 24 * 60 * 60 * 1000;
export const TOMBSTONE_RETENTION = 48 * 60 * 60 * 1000;
const fields = [
  "version",
  "installationId",
  "projectId",
  "agentRevision",
  "conversationId",
  "branchId",
  "runId",
  "turnId",
  "operationId",
  "operationIssuedAt",
  "kind",
  "cause",
  "parentOperationId",
];
export function validateContext(value: unknown, now = Date.now()): ModelRequestContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("request_context");
  const c = value as Record<string, unknown>;
  if (Object.keys(c).some((k) => !fields.includes(k)) || c.version !== 1)
    invalid("request_context");
  for (const k of [
    "installationId",
    "projectId",
    "agentRevision",
    "conversationId",
    "branchId",
    "runId",
    "turnId",
    "operationId",
  ])
    if (typeof c[k] !== "string" || !/^[A-Za-z0-9_.:@/-]{1,256}$/.test(c[k] as string))
      invalid(`request_context.${k}`);
  if (!["turn", "title", "helper", "subagent", "compaction"].includes(String(c.kind)))
    invalid("request_context.kind");
  if (
    c.parentOperationId !== undefined &&
    (typeof c.parentOperationId !== "string" ||
      !/^[A-Za-z0-9_.:@/-]{1,256}$/.test(c.parentOperationId))
  )
    invalid("request_context.parentOperationId");
  if (
    c.cause !== undefined &&
    !["generation", "empty_turn_retry", "regeneration"].includes(String(c.cause))
  )
    invalid("request_context.cause");
  if (!Number.isSafeInteger(c.operationIssuedAt) || Number(c.operationIssuedAt) > now + 30000)
    invalid("request_context.operationIssuedAt");
  if (Number(c.operationIssuedAt) < now - OPERATION_WINDOW)
    terminal(
      "operation_expired",
      "This logical operation is older than the 24-hour retry window. Recover the run before starting a new operation.",
    );
  return c as unknown as ModelRequestContext;
}
export function attestContext(
  context: ModelRequestContext,
  key: string,
  attemptAt = Date.now(),
): string {
  const payload = Buffer.from(JSON.stringify({ context, attemptAt })).toString("base64url");
  const signature = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}
export function verifyContext(encoded: string, key: string, now = Date.now()): ModelRequestContext {
  if (encoded.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(encoded))
    invalid("request_context");
  const [payload, signature] = encoded.split("."),
    expected = createHmac("sha256", key).update(payload!).digest(),
    actual = Buffer.from(signature!, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual))
    throw new WireError(401, "invalid_context", "The server request context signature is invalid.");
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(Buffer.from(payload!, "base64url").toString());
  } catch {
    invalid("request_context");
  }
  if (
    Object.keys(envelope).some((k) => !["context", "attemptAt"].includes(k)) ||
    !Number.isSafeInteger(envelope.attemptAt) ||
    Math.abs(now - Number(envelope.attemptAt)) > 300000
  )
    throw new WireError(401, "expired_attestation", "The per-attempt server attestation is stale.");
  return validateContext(envelope.context, now);
}
