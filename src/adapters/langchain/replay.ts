import { isDeepStrictEqual } from "node:util";
import type { AIMessage } from "@langchain/core/messages";
import { wireName } from "../../core/tool-names.js";
import { assert, record } from "../../core/errors.js";
import type { ReplayMetadata } from "../../core/codec.js";
import type { Session } from "../../core/types.js";

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

  restore(message: AIMessage, session: Session, wire: ReplayMetadata["wire"]): ReplayMetadata {
    const calls = message.tool_calls ?? [];
    assert(calls.length > 0, "A reconstructed tool message has no calls.");
    const metadata = this.entries.get(calls[0]!.id ?? "");
    assert(
      metadata,
      "Provider replay metadata is missing. In-flight tool continuation after a process restart is unsupported; restart this Agent execution with a complete memory session.",
    );
    assert(
      metadata.affinity === session.affinity && metadata.wire === wire,
      "Replay state belongs to another account or route. Use a separate memory session.",
    );
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
