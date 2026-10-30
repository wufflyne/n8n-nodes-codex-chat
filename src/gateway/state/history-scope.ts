import type { ModelInfo } from "../../core/types.js";
import { terminal } from "../errors.js";

/** Server-selected local codec revision, never a client or provider response field. */
export interface HistoryScope {
  account: string;
  model: string;
  branch: string | null;
  codec: "responses-v1" | "responses-lite-v1";
}

export function historyCodec(model: ModelInfo): HistoryScope["codec"] {
  return model.useResponsesLite ? "responses-lite-v1" : "responses-v1";
}

export function assertHistoryScope(
  actual: HistoryScope | undefined,
  expected: HistoryScope | undefined,
): void {
  if (
    !actual || !expected ||
    !["responses-v1", "responses-lite-v1"].includes(actual.codec)
  )
    terminal(
      "history_scope_unproven",
      "This retained result has no supported route/codec proof. Recover the run explicitly or start a new conversation; its history cannot be reused automatically.",
    );
  if (
    actual.account !== expected.account ||
    actual.model !== expected.model ||
    actual.branch !== expected.branch ||
    actual.codec !== expected.codec
  )
    terminal(
      "history_conflict",
      "The retained result belongs to another account, model, route/codec or conversation branch. Recover this conversation explicitly.",
    );
}
