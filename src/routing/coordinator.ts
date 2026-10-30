import { createHash } from "node:crypto";
import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import { assert } from "../core/errors.js";
import type { ExecutionContext } from "../core/affinity.js";
import { ReplayLedger } from "../core/replay.js";
export interface RouterCoordinator {
  state: "new" | "selecting" | "pinned" | "finished" | "failed";
  inFlight: boolean;
  signature?: string;
  descriptorSignature?: string;
  initial?: string;
  initialCount: number;
  pinned?: number;
  affinity?: string;
  pending: Set<string>;
  known: Set<string>;
  replay: ReplayLedger;
}
const coordinators = new Map<string, RouterCoordinator>();
const key = (c: ExecutionContext) =>
  JSON.stringify([c.workflowId, c.executionId, c.nodeId]);
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function coordinator(context: ExecutionContext): {
  value: RouterCoordinator;
  created: boolean;
} {
  const k = key(context);
  let value = coordinators.get(k);
  if (value) return { value, created: false };
  assert(coordinators.size < 128, "Too many active account router executions.");
  value = {
    state: "new",
    inFlight: false,
    initialCount: 0,
    pending: new Set(),
    known: new Set(),
    replay: new ReplayLedger(),
  };
  coordinators.set(k, value);
  return { value, created: true };
}
function projection(messages: BaseMessage[]) {
  return messages.map((m) => ({ type: m.getType(), content: m.content }));
}
export function enter(
  state: RouterCoordinator,
  messages: BaseMessage[],
  signature: string,
) {
  assert(
    !state.inFlight,
    "This account router already has a model call in flight. Use a separate sub-workflow execution for each item.",
  );
  assert(
    !["finished", "failed"].includes(state.state),
    "This account router supports one fresh Agent invocation per execution. Start a new execution.",
  );
  assert(
    !state.signature || state.signature === signature,
    "The router candidate set or semantic settings changed during this invocation.",
  );
  if (state.state === "new") {
    assert(
      messages.length > 0 &&
        messages.some((m) => m.getType() === "human") &&
        messages.every(
          (m) =>
            ["system", "human"].includes(m.getType()) &&
            !m.additional_kwargs.codex_response &&
            !m.additional_kwargs.codex_replay_part,
        ),
      "This conversation already contains model history. Use account-scoped memory with Model Selector, or start a fresh invocation.",
    );
    state.initial = fingerprint(projection(messages));
    state.initialCount = messages.length;
    state.signature = signature;
    state.state = "selecting";
  } else {
    assert(
      state.state === "pinned" && state.pending.size > 0,
      "The account router cannot start another root invocation in this execution.",
    );
    assert(
      fingerprint(projection(messages.slice(0, state.initialCount))) ===
        state.initial,
      "The user prefix changed during this account-pinned invocation.",
    );
    const continuation = messages.slice(state.initialCount);
    assert(
      continuation.length > 0 &&
        continuation.every((m) => ["ai", "tool"].includes(m.getType())),
      "The account router accepts only the current tool-turn continuation after admission.",
    );
    const results = new Set(
      continuation
        .filter((m) => m.getType() === "tool")
        .map((m) => (m as BaseMessage & { tool_call_id: string }).tool_call_id),
    );
    assert(
      [...state.pending].every((id) => results.has(id)) &&
        [...results].every((id) => state.known.has(id)),
      "Tool continuation contains missing or unknown account-pinned call identifiers.",
    );
    for (const m of continuation)
      if (m.getType() === "ai") {
        const calls = (m as AIMessage).tool_calls;
        assert(
          calls?.length && calls.every((c) => c.id && state.known.has(c.id)),
          "The account router cannot accept unrecognized model history.",
        );
      }
  }
  state.inFlight = true;
}
export function completeTurn(state: RouterCoordinator, message: AIMessage) {
  state.pending.clear();
  for (const call of message.tool_calls ?? []) {
    assert(
      call.id && !state.known.has(call.id),
      "The provider reused a router tool call identifier.",
    );
    state.pending.add(call.id);
    state.known.add(call.id);
  }
  if (!state.pending.size) state.state = "finished";
}
export function clearCoordinator(context: ExecutionContext) {
  const value = coordinators.get(key(context));
  value?.replay.clear();
  coordinators.delete(key(context));
}
export function routerResourceCount() {
  return coordinators.size;
}
