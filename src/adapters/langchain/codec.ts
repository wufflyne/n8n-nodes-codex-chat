import { outputText } from "../../kernel/completion.js";
import { validator } from "../../kernel/structured.js";
export { outputText } from "../../kernel/completion.js";
import { ReplayLedger, validateReplayPart } from "../../core/replay.js";
import { isDeepStrictEqual } from "node:util";
import { normalizeImage, type ImageBudget } from "../../image/validation.js";
import { jsonSnapshot } from "../../core/snapshot.js";
import { normalizeUsage, langChainUsage } from "../../core/usage.js";
import { wireName } from "../../core/tool-names.js";
export { wireName } from "../../core/tool-names.js";
import {
  AIMessage,
  type BaseMessage,
  type ToolCall,
} from "@langchain/core/messages";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import type { BindToolsInput } from "@langchain/core/language_models/chat_models";
import { CodexError, assert, record, string } from "../../core/errors.js";
import {
  PROVIDER,
  type CompletedResponse,
  type ModelInfo,
  type ModelSettings,
  type ProviderTool,
  type ResponseItem,
  type ResponseRequest,
  type Session,
} from "../../core/types.js";

export interface ToolRegistry {
  tools: ProviderTool[];
  names: Map<string, string>;
}
export interface ReplayMetadata {
  version: 1;
  provider: typeof PROVIDER;
  affinity: string;
  wire: "responses" | "responses-lite";
  items: ResponseItem[];
  prefix?: ResponseItem[];
}

const registries = new WeakMap<object, ToolRegistry>();
export function toolRegistry(tools: BindToolsInput[] = []): ToolRegistry {
  const cached = registries.get(tools);
  if (cached) return cached;
  const names = new Map<string, string>();
  const converted = tools.map((tool) => {
    let result;
    try {
      result = convertToOpenAITool(tool);
    } catch {
      throw new CodexError(
        "configuration",
        "A connected tool could not be converted to a JSON function schema.",
      );
    }
    const fn = record(result.function);
    const original = string(fn.name, "Tool name", 1024);
    const name = wireName(original);
    assert(!names.has(name), "Connected tool names must be unique.");
    names.set(name, original);
    assert(
      fn.strict === undefined || typeof fn.strict === "boolean",
      "Tool strictness must be a boolean.",
    );
    const parameters = jsonSnapshot(
      record(fn.parameters ?? { type: "object", properties: {} }),
    );
    validator(parameters);
    return {
      type: "function" as const,
      name,
      description:
        typeof fn.description === "string" ? fn.description : undefined,
      parameters,
      ...(fn.strict === undefined ? {} : { strict: fn.strict }),
    };
  });
  return { tools: converted, names };
}

/** Only privately created deep snapshots may reuse normalization across invocations. */
export function boundToolsSnapshot(tools: BindToolsInput[]): BindToolsInput[] {
  const registry = toolRegistry(tools);
  const owned = jsonSnapshot(
    registry.tools.map((tool) => ({
      type: "function",
      function: {
        name: registry.names.get(tool.name)!,
        ...(tool.description === undefined
          ? {}
          : { description: tool.description }),
        parameters: tool.parameters,
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      },
    })),
    4 * 1024 * 1024,
  ) as BindToolsInput[];
  // The parameter snapshots are already deep-frozen; seal their private wrappers too.
  registry.tools.forEach(Object.freeze);
  Object.freeze(registry.tools);
  registries.set(owned, registry);
  return owned;
}

function contentItems(
  content: BaseMessage["content"],
  assistant: boolean,
  model: ModelInfo,
  budget: ImageBudget,
): Array<Record<string, unknown>> {
  if (typeof content === "string")
    return [{ type: assistant ? "output_text" : "input_text", text: content }];
  return content.map((block) => {
    assert(
      typeof block === "object" && block !== null,
      "A message content block is invalid.",
    );
    if (
      block.type === "text" ||
      block.type === "input_text" ||
      block.type === "output_text"
    ) {
      assert(typeof block.text === "string", "Message text must be a string.");
      return {
        type: assistant ? "output_text" : "input_text",
        text: block.text,
      };
    }
    if (
      !assistant &&
      ["image_url", "image", "input_image"].includes(String(block.type))
    )
      return normalizeImage(block, model, budget);
    throw new CodexError(
      "configuration",
      "This message content type is unsupported. Use text or an advertised image input; audio, video, direct files and hosted tools are unavailable.",
    );
  });
}

function toolOutput(content: BaseMessage["content"]): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

export function buildRequest(
  messages: BaseMessage[],
  model: ModelInfo,
  settings: ModelSettings,
  registry: ToolRegistry,
  session: Session,
  toolChoice?: unknown,
  replay?: ReplayLedger,
): ResponseRequest {
  const input: ResponseItem[] = [];
  const imageBudget: ImageBudget = { count: 0, bytes: 0 };
  const instructions: string[] = [];
  const calls = new Map<string, { name: string; namespace?: string }>();
  const seen = new Map<string, ResponseItem>();
  const replayed = new Set<string>();
  const results = new Set<string>();
  const wire = model.useResponsesLite ? "responses-lite" : "responses";
  const add = (item: ResponseItem, deduplicate = false) => {
    const key = item.id
      ? `id:${item.id}`
      : item.type === "function_call"
        ? `call:${item.call_id}`
        : item.type === "function_call_output"
          ? `result:${item.call_id}`
          : undefined;
    if (key) {
      const previous = seen.get(key);
      if (deduplicate && previous) {
        assert(
          isDeepStrictEqual(previous, item),
          "Stored replay history conflicts with the current tool round.",
        );
        return;
      }
      assert(
        !previous,
        "History contains a duplicate provider item or tool result. Check the connected memory node.",
      );
      seen.set(key, item);
    }
    if (item.type === "function_call_output") {
      assert(
        calls.has(String(item.call_id)),
        "Stored tool results have no matching call.",
      );
      results.add(String(item.call_id));
    }
    if (item.type === "function_call") {
      assert(
        !calls.has(String(item.call_id)),
        "History contains duplicate tool call identifiers.",
      );
      calls.set(string(item.call_id, "Tool call identifier", 256), {
        name: string(item.name, "Tool name", 256),
        namespace:
          typeof item.namespace === "string" ? item.namespace : undefined,
      });
    }
    input.push(item);
  };
  for (const message of messages) {
    const type = message.getType();
    if (type === "system") {
      assert(
        typeof message.content === "string",
        "System instructions must be text.",
      );
      if (model.useResponsesLite)
        add({
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: message.content }],
        });
      else instructions.push(message.content);
    } else if (type === "human") {
      add({
        type: "message",
        role: "user",
        content: contentItems(message.content, false, model, imageBudget),
      });
    } else if (type === "ai") {
      const ai = message as AIMessage;
      const saved =
        message.additional_kwargs.codex_response ??
        (replay && ai.tool_calls?.length
          ? replay.restore(ai, session, wire)
          : undefined);
      if (saved !== undefined) {
        const metadata = record(saved);
        assert(
          metadata.version === 1 &&
            metadata.provider === PROVIDER &&
            metadata.affinity === session.affinity &&
            metadata.wire === wire &&
            Array.isArray(metadata.items),
          "History belongs to a different account or wire format. Use a separate memory session for this profile and model route.",
        );
        if (message.additional_kwargs.codex_replay_part !== undefined) {
          validateReplayPart(ai, metadata as unknown as ReplayMetadata);
          const group = JSON.stringify(
            metadata.items
              .filter((item: ResponseItem) => item.type === "function_call")
              .map((item: ResponseItem) => item.call_id),
          );
          if (replayed.has(group)) continue;
          replayed.add(group);
        }
        if (metadata.prefix !== undefined) {
          assert(
            Array.isArray(metadata.prefix),
            "Stored replay history is invalid.",
          );
          for (const item of metadata.prefix)
            add(record(item) as ResponseItem, true);
        }
        for (const item of metadata.items) add(record(item) as ResponseItem);
      } else {
        if (typeof message.content !== "string" || message.content.length > 0)
          add({
            type: "message",
            role: "assistant",
            content: contentItems(message.content, true, model, imageBudget),
          });
        const ai = message as AIMessage;
        for (const call of ai.tool_calls ?? [])
          add({
            type: "function_call",
            call_id: string(call.id, "Tool call identifier", 256),
            name: wireName(call.name),
            ...(model.useResponsesLite ? { namespace: "functions" } : {}),
            arguments: JSON.stringify(call.args),
          });
      }
    } else if (type === "tool") {
      const id = string(
        (message as BaseMessage & { tool_call_id: string }).tool_call_id,
        "Tool result call identifier",
        256,
      );
      const call = calls.get(id);
      assert(
        call,
        "A tool result has no matching call in history. Use a memory node that preserves complete tool rounds.",
      );
      add({
        type: "function_call_output",
        call_id: id,
        output: toolOutput(message.content),
        ...(model.useResponsesLite
          ? { name: call.name, namespace: call.namespace ?? "functions" }
          : {}),
      });
    } else
      throw new CodexError(
        "configuration",
        "This message role is unsupported by the Codex provider.",
      );
  }
  assert(
    [...calls.keys()].every((id) => results.has(id)),
    "History contains an incomplete tool round. Use memory that retains every tool result.",
  );
  const choice = normalizeToolChoice(toolChoice);
  const request: ResponseRequest = {
    model: model.slug,
    stream: true,
    store: false,
    input,
    include: ["reasoning.encrypted_content"],
    tool_choice: choice,
    parallel_tool_calls: model.useResponsesLite
      ? false
      : (settings.parallelToolCalls ?? true),
  };
  if (model.useResponsesLite) {
    if (registry.tools.length)
      input.unshift({
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "functions",
            description: "",
            tools: registry.tools,
          },
        ],
      });
  } else {
    if (instructions.length)
      input.unshift({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: instructions.join("\n\n") }],
      });
    request.tools = registry.tools;
  }
  if (
    model.useResponsesLite ||
    settings.reasoningEffort ||
    settings.reasoningSummary
  )
    request.reasoning = {
      ...(model.useResponsesLite ? { context: "all_turns" as const } : {}),
      ...(settings.reasoningEffort ? { effort: settings.reasoningEffort } : {}),
      ...(settings.reasoningSummary
        ? { summary: settings.reasoningSummary }
        : {}),
    };
  if (settings.verbosity) request.text = { verbosity: settings.verbosity };
  if (settings.serviceTier) request.service_tier = settings.serviceTier;
  assert(
    Buffer.byteLength(JSON.stringify(request)) <= 32 * 1024 * 1024,
    "The conversation exceeds the 32 MiB request limit. Reduce history or attachment size.",
  );
  return request;
}

function normalizeToolChoice(choice: unknown): unknown {
  if (choice === undefined || choice === "auto") return "auto";
  throw new CodexError(
    "configuration",
    "The experimental Codex backend supports automatic tool selection only in this release. Remove the forced tool choice; the native Agent output parser uses an automatically selected tool.",
  );
}

export function outputMessage(
  response: CompletedResponse,
  registry: ToolRegistry,
  session: Session,
  model: ModelInfo,
  structured = false,
): AIMessage {
  const toolCalls: ToolCall[] = [];
  const invalidCalls: Array<{
    id: string;
    name: string;
    args: string;
    error: string;
    type: "invalid_tool_call";
  }> = [];
  const ids = new Set<string>();
  for (const item of response.output) {
    if (item.type !== "function_call") continue;
    const id = string(item.call_id, "Provider tool call identifier", 256);
    assert(
      !ids.has(id),
      "The provider returned duplicate tool call identifiers.",
    );
    ids.add(id);
    assert(
      item.status === undefined || item.status === "completed",
      "The provider returned an unfinished tool call.",
    );
    assert(
      item.namespace === undefined || item.namespace === "functions",
      "The provider returned an unknown tool namespace.",
    );
    const providerName = string(item.name, "Provider tool name", 256);
    const name =
      registry.names.get(providerName) ??
      (structured ? providerName : undefined);
    assert(
      name,
      "The provider requested a tool that is not connected to this model.",
    );
    let args: Record<string, unknown>;
    try {
      args = record(
        JSON.parse(
          string(item.arguments, "Provider tool arguments", 4 * 1024 * 1024),
        ),
      );
    } catch {
      if (structured) {
        invalidCalls.push({
          id,
          name,
          args: typeof item.arguments === "string" ? item.arguments : "",
          error: "Invalid structured function arguments.",
          type: "invalid_tool_call",
        });
        continue;
      }
      throw new CodexError(
        "protocol",
        "The provider returned invalid tool arguments. No tool calls were released.",
      );
    }
    toolCalls.push({ id, name, args, type: "tool_call" });
  }
  const metadata: ReplayMetadata = {
    version: 1,
    provider: PROVIDER,
    affinity: session.affinity,
    wire: model.useResponsesLite ? "responses-lite" : "responses",
    items: response.output,
  };
  const usage = normalizeUsage(response.usage);
  return new AIMessage({
    id: response.id,
    content: outputText(response),
    tool_calls: toolCalls,
    invalid_tool_calls: invalidCalls,
    additional_kwargs: { codex_response: metadata },
    response_metadata: {
      provider: PROVIDER,
      model: model.slug,
      responseId: response.id,
      usage,
      ...(invalidCalls.length ? { structuredInvalidArguments: true } : {}),
      refusal: response.output.some(
        (item) =>
          Array.isArray(item.content) &&
          item.content.some(
            (block: unknown) =>
              block &&
              typeof block === "object" &&
              (block as Record<string, unknown>).type === "refusal",
          ),
      ),
      ...(response.service_tier ? { serviceTier: response.service_tier } : {}),
    },
    usage_metadata: langChainUsage(usage),
  });
}
