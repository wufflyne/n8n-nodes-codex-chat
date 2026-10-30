import { assert, record, string } from "../core/errors.js";
import type { CompletedResponse, ProviderTool } from "../core/types.js";
import { validator } from "./structured.js";
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
): void {
  assert(response.status === "completed", "The provider did not complete this response.");
  assert(
    !streamedText || outputText(response) === streamedText,
    "The completed response text differs from its streaming deltas.",
  );
  const ids = new Set<string>(),
    itemIds = new Set<string>();
  for (const item of response.output) {
    assert(
      ["message", "agent_message", "reasoning", "function_call"].includes(String(item.type)),
      "The provider returned an unsupported output item.",
    );
    if (item.id !== undefined) {
      const id = string(item.id, "Provider item identifier", 256);
      assert(!itemIds.has(id), "The provider returned duplicate output item identifiers.");
      itemIds.add(id);
    }
    if (item.type === "message" || item.type === "agent_message") {
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
    if (item.type === "reasoning") {
      assert(
        item.summary === undefined ||
          (Array.isArray(item.summary) &&
            item.summary.every((raw) => {
              const part = record(raw);
              return part.type === "summary_text" && typeof part.text === "string";
            })),
        "Provider reasoning summary is invalid.",
      );
      assert(
        item.encrypted_content === undefined || typeof item.encrypted_content === "string",
        "Provider encrypted reasoning is invalid.",
      );
    }
    if (item.type !== "function_call") continue;
    const id = string(item.call_id, "Provider call identifier", 256);
    assert(!ids.has(id), "The provider returned duplicate tool call identifiers.");
    ids.add(id);
    assert(
      item.status === undefined || item.status === "completed",
      "The provider returned an unfinished tool call.",
    );
    assert(
      item.namespace === undefined || item.namespace === "functions",
      "The provider returned an unknown namespace.",
    );
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
}
