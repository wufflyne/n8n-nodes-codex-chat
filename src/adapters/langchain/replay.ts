import { isDeepStrictEqual } from "node:util";
import type { AIMessage } from "@langchain/core/messages";
import { wireName } from "../../core/tool-names.js";
import { assert, record } from "../../core/errors.js";
import type { ReplayMetadata } from "../../core/codec.js";
import type { Session } from "../../core/types.js";
import { outputText } from "../../kernel/completion.js";

export function validateReplayProvenance(metadata: ReplayMetadata, session: Session, model: string, wire: ReplayMetadata["wire"]): void {
  assert(metadata.version === 2, "Legacy Codex replay metadata cannot be reused safely. Preserve or export the old memory, then begin a separately named new memory session.");
  assert(metadata.provider === "codex-subscription-experimental" && metadata.affinity === session.affinity && metadata.model === model && metadata.wire === wire && metadata.codec === (wire === "responses" ? "responses-v1" : "responses-lite-v1") && Array.isArray(metadata.items), "History belongs to a different account, exact model or known codec. Preserve the memory and use a separate session.");
}
function visibleText(message: AIMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((raw) => {
    const block = record(raw);
    assert(["text", "input_text", "output_text"].includes(String(block.type)) && typeof block.text === "string", "Saved assistant text contains an unsupported visible block.");
    return block.text;
  }).join("");
}
export function validateReplayFull(message: AIMessage, metadata: ReplayMetadata): void {
  assert(visibleText(message) === outputText({ id: "projection", status: "completed", output: metadata.items }), "Visible assistant text differs from saved provider history.");
  const originals = metadata.items.filter((item) => item.type === "function_call");
  if (metadata.diagnostic === "owned-structured-output") {
    const invalid = message.invalid_tool_calls ?? [];
    assert(!(message.tool_calls ?? []).length && invalid.length === originals.length, "Visible structured diagnostics differ from saved provider history.");
    invalid.forEach((call, index) => {
      const original = originals[index]!;
      assert(call.id === original.call_id && wireName(call.name ?? "") === original.name && call.args === original.arguments && call.error === "Invalid owned structured output.", "Visible structured diagnostics differ from saved provider history.");
    });
    return;
  }
  assert(!(message.invalid_tool_calls ?? []).length && (message.tool_calls ?? []).length === originals.length, "Visible tool call membership differs from saved provider history.");
  (message.tool_calls ?? []).forEach((call, index) => {
    assert(call.id === originals[index]!.call_id, "Visible tool call order differs from saved provider history.");
  });
  validateReplayPart(message, metadata);
}

/** n8n Agent V3 reconstructs tool messages without generic provider metadata. */
export class ReplayLedger {
  private static totalBytes = 0;
  private readonly entries = new Map<string, ReplayMetadata>();
  private bytes = 0;
  private groups = 0;
  private affinity?: string;
  constructor(private readonly limitBytes = 16 * 1024 * 1024) {}

  remember(metadata: ReplayMetadata): void {
    const calls = metadata.items.filter((item) => item.type === "function_call");
    if (!calls.length) return;
    assert(
      !this.affinity || this.affinity === metadata.affinity,
      "Replay state belongs to another account. Restart the Agent execution.",
    );
    const bytes = Buffer.byteLength(JSON.stringify(metadata));
    assert(
      this.groups < 128 &&
        this.bytes + bytes <= this.limitBytes &&
        ReplayLedger.totalBytes + bytes <= 64 * 1024 * 1024,
      "The Agent replay limit was reached. Reduce tool rounds or history and start a new execution.",
    );
    const snapshot = structuredClone(metadata);
    for (const item of calls)
      assert(
        typeof item.call_id === "string" && !this.entries.has(item.call_id),
        "The provider reused an active tool call identifier.",
      );
    this.affinity = metadata.affinity;
    for (const item of calls) this.entries.set(String(item.call_id), snapshot);
    this.groups++;
    this.bytes += bytes;
    ReplayLedger.totalBytes += bytes;
  }

  restore(message: AIMessage, session: Session, wire: ReplayMetadata["wire"], model: string): ReplayMetadata {
    const calls = message.tool_calls ?? [];
    assert(calls.length > 0, "A reconstructed tool message has no calls.");
    const metadata = this.entries.get(calls[0]!.id ?? "");
    assert(
      metadata,
      "Provider replay metadata is missing. In-flight tool continuation after a process restart is unsupported; restart this Agent execution with a complete memory session.",
    );
    validateReplayProvenance(metadata, session, model, wire);
    assert(
      calls.every((call) => this.entries.get(call.id ?? "") === metadata),
      "Reconstructed tool calls combine different provider responses.",
    );
    validateReplayPart(message, metadata);
    // The native Agent saves these same message instances to memory after its final round.
    message.additional_kwargs.codex_response = structuredClone(metadata);
    message.additional_kwargs.codex_replay_part = calls.map((call) => call.id!);
    return metadata;
  }

  clear(): void {
    this.entries.clear();
    ReplayLedger.totalBytes -= this.bytes;
    this.bytes = 0;
    this.groups = 0;
    this.affinity = undefined;
  }
}

export function validateReplayPart(message: AIMessage, metadata: ReplayMetadata): void {
  const originals = metadata.items.filter((item) => item.type === "function_call");
  const part = message.additional_kwargs.codex_replay_part;
  const calls = message.tool_calls ?? [];
  assert(!(message.invalid_tool_calls ?? []).length, "Split replay cannot contain invalid tool diagnostics.");
  const text = visibleText(message);
  assert(!text || text === outputText({ id: "projection", status: "completed", output: metadata.items }), "Visible split assistant text differs from saved provider history.");
  if (part !== undefined)
    assert(
      Array.isArray(part) &&
        isDeepStrictEqual(
          part,
          calls.map((call) => call.id),
        ),
      "Stored replay call identities are invalid.",
    );
  for (const call of calls) {
    const original = originals.find((item) => item.call_id === call.id);
    assert(
      original && typeof original.arguments === "string",
      "Reconstructed tool call identifiers do not match provider history.",
    );
    let args: unknown;
    try {
      args = JSON.parse(original.arguments);
    } catch {
      assert(false, "Stored provider tool arguments are invalid.");
    }
    // Compare the stable provider name. The original n8n name may require wire mapping.
    assert(
      original.name === wireName(call.name) && isDeepStrictEqual(record(args), call.args),
      "Reconstructed tool names or arguments differ from provider history.",
    );
  }
}
