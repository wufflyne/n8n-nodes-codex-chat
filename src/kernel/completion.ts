import { assert, record, string } from "../core/errors.js";
import type { CompletedResponse, ProviderTool, ResponseItem } from "../core/types.js";
import { validator } from "./structured.js";
import type { OutputContract } from "./output-contract.js";

export function validateReasoning(item: ResponseItem): void {
  assert(Array.isArray(item.summary) && item.summary.every((raw) => {
    const part = record(raw);
    return part.type === "summary_text" && typeof part.text === "string" && Object.keys(part).every((key) => ["type", "text"].includes(key));
  }), "Provider reasoning summary must be an array of summary text entries, including when empty.");
  assert(typeof item.encrypted_content === "string" && item.encrypted_content.length > 0 && item.encrypted_content.length <= 4 * 1024 * 1024, "Provider reasoning requires bounded encrypted replay content.");
}
export function outputText(response: CompletedResponse): string {
  const parts: string[] = [];
  for (const item of response.output) {
    if (item.type !== "message" && item.type !== "agent_message") continue;
    if (!Array.isArray(item.content)) continue;
    for (const content of item.content) {
      const block = record(content);
      if (
        ["output_text", "text", "input_text"].includes(String(block.type)) &&
        typeof block.text === "string"
      )
        parts.push(block.text);
      if (block.type === "refusal" && typeof block.refusal === "string") parts.push(block.refusal);
    }
  }
  return parts.join("");
}

/** All executable calls are validated as one terminal batch before any is released. */
export function validateCompletion(
  response: CompletedResponse,
  tools: ProviderTool[],
  streamedText = "",
  contract: OutputContract = { kind: "tools" },
): "valid" | "owned-diagnostic" {
  assert(response.status === "completed", "The provider did not complete this response.");
  assert(Array.isArray(response.output) && response.output.length <= 256 && Buffer.byteLength(JSON.stringify(response)) <= 4 * 1024 * 1024, "The completed response exceeds its structural bound.");
  assert(
    !streamedText || outputText(response) === streamedText,
    "The completed response text differs from its streaming deltas.",
  );
  const ids = new Set<string>(),
    itemIds = new Set<string>();
  for (const item of response.output) {
    assert(
      ["message", "reasoning", "function_call"].includes(String(item.type)),
      "The provider returned an unsupported output item.",
    );
    if (item.id !== undefined) {
      const id = string(item.id, "Provider item identifier", 256);
      assert(!itemIds.has(id), "The provider returned duplicate output item identifiers.");
      itemIds.add(id);
    }
    if (item.type === "message") {
      assert(item.role === "assistant", "Provider message role must be assistant for replayable output.");
      assert(item.phase == null || (typeof item.phase === "string" && ["commentary", "partial_answer", "final_answer"].includes(item.phase)), "Provider message phase is unsupported.");
      assert(Array.isArray(item.content), "Provider message content is invalid.");
      for (const raw of item.content) {
        const part = record(raw);
        assert(
          ["output_text", "text", "input_text", "refusal"].includes(String(part.type)),
          "The provider returned unsupported message content.",
        );
        assert(
          typeof (part.type === "refusal" ? part.refusal : part.text) === "string",
          "Provider message text is invalid.",
        );
      }
    }
    if (item.type === "reasoning") validateReasoning(item);
    if (item.type !== "function_call") continue;
    const id = string(item.call_id, "Provider call identifier", 256);
    assert(!ids.has(id), "The provider returned duplicate tool call identifiers.");
    ids.add(id);
    string(item.name, "Provider tool name", 256);
    assert(typeof item.arguments === "string" && item.arguments.length <= 4 * 1024 * 1024, "Provider tool arguments are structurally invalid.");
    assert(
      item.status === undefined || item.status === "completed",
      "The provider returned an unfinished tool call.",
    );
    assert(
      item.namespace === undefined || item.namespace === "functions",
      "The provider returned an unknown namespace.",
    );
    if (contract.kind !== "tools") continue;
    assert(
      tools.some((t) => t.name === item.name),
      "The provider requested an unconnected tool.",
    );
    try {
      const args = record(
        JSON.parse(string(item.arguments, "Provider arguments", 4 * 1024 * 1024)),
      );
      assert(
        validator(tools.find((tool) => tool.name === item.name)!.parameters)(args),
        "Tool arguments do not match the connected schema.",
      );
    } catch {
      assert(false, "The provider returned invalid tool arguments. No tool calls were released.");
    }
  }
  if (contract.kind !== "tools") {
    const calls = response.output.filter((item) => item.type === "function_call");
    try {
      assert(!response.output.some((item) => Array.isArray(item.content) && item.content.some((part) => record(part).type === "refusal")), "Structured refusal.");
      if (contract.kind === "owned-function") {
        assert(calls.length === 1 && calls[0]!.name === contract.tool.name, "Owned function mismatch.");
        assert(validator(contract.tool.parameters)(record(JSON.parse(String(calls[0]!.arguments)))), "Owned schema mismatch.");
      } else {
        assert(calls.length === 0 && validator(contract.format.schema)(JSON.parse(outputText(response))), "Owned JSON mismatch.");
      }
    } catch { return "owned-diagnostic"; }
  }
  return "valid";
}
