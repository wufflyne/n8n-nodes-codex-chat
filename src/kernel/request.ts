import { isDeepStrictEqual } from "node:util";
import { normalizeImage, type ImageBudget } from "../image/validation.js";
import { validateSettings } from "../core/catalog.js";
import { assert, record, string } from "../core/errors.js";
import type {
  ModelInfo,
  ModelSettings,
  ProviderTool,
  ResponseItem,
  ResponseRequest,
} from "../core/types.js";
import {
  validatedOutputFormat,
  validator,
  type StructuredFormat,
} from "./structured.js";

export interface CanonicalGeneration {
  model: string;
  input: ResponseItem[];
  instructions?: string;
  tools: ProviderTool[];
  settings: ModelSettings;
  format?: StructuredFormat;
}

/** Canonical history is exact caller-supplied history; no inferred or restored text. */
export function validateHistory(
  items: ResponseItem[],
  model: ModelInfo,
): ResponseItem[] {
  const calls = new Map<string, ResponseItem>(),
    results = new Set<string>(),
    ids = new Set<string>();
  const budget: ImageBudget = { count: 0, bytes: 0 };
  const input = items.map((raw) => {
    const item = structuredClone(raw);
    if (item.id) {
      assert(!ids.has(item.id), "Duplicate history item identifier.");
      ids.add(item.id);
    }
    if (!item.type || item.type === "message") {
      assert(
        ["system", "developer", "user", "assistant"].includes(
          String(item.role),
        ),
        "Unsupported history role.",
      );
      const assistant = item.role === "assistant";
      const content =
        typeof item.content === "string"
          ? [
              {
                type: assistant ? "output_text" : "input_text",
                text: item.content,
              },
            ]
          : item.content;
      assert(
        Array.isArray(content),
        "Message content must contain text or supported images.",
      );
      item.type = "message";
      item.content = content.map((v: unknown) => {
        const block = record(v);
        if (
          ["input_text", "output_text", "text"].includes(String(block.type))
        ) {
          assert(
            typeof block.text === "string",
            "Message text must be a string.",
          );
          return {
            type: assistant ? "output_text" : "input_text",
            text: block.text,
          };
        }
        if (!assistant && block.type === "input_image")
          return normalizeImage(block, model, budget);
        if (assistant && block.type === "refusal")
          return { type: "refusal", refusal: string(block.refusal, "Refusal") };
        assert(false, "Unsupported message content type.");
      });
    } else if (item.type === "function_call") {
      const id = string(item.call_id, "Tool call identifier", 256);
      assert(!calls.has(id), "Duplicate tool call identifier.");
      string(item.name, "Tool name", 256);
      record(
        JSON.parse(string(item.arguments, "Tool arguments", 4 * 1024 * 1024)),
      );
      assert(
        item.status === undefined || item.status === "completed",
        "An unfinished call cannot be replayed.",
      );
      calls.set(id, item);
      if (model.useResponsesLite) item.namespace = "functions";
    } else if (item.type === "function_call_output") {
      const id = string(item.call_id, "Tool result identifier", 256),
        call = calls.get(id);
      assert(
        call && !results.has(id),
        "Tool result has no unique preceding call.",
      );
      results.add(id);
      assert(
        typeof item.output === "string",
        "Tool results must be serialized text.",
      );
      if (model.useResponsesLite) {
        item.name = call.name;
        item.namespace = "functions";
      }
    } else if (item.type === "reasoning") {
      assert(
        typeof item.encrypted_content === "string" &&
          item.encrypted_content.length > 0,
        "Reasoning replay requires encrypted content.",
      );
      assert(
        Array.isArray(item.summary),
        "Reasoning summary must be an array, including when empty.",
      );
    } else assert(false, "Unsupported replay item.");
    return item;
  });
  assert(
    [...calls.keys()].every((id) => results.has(id)),
    "History contains an incomplete tool round.",
  );
  return input;
}

export function canonicalRequest(
  value: CanonicalGeneration,
  model: ModelInfo,
  strictParallel = true,
): ResponseRequest {
  assert(
    value.model === model.slug,
    "A different model cannot be substituted.",
  );
  validateSettings(model, value.settings);
  assert(
    !strictParallel ||
      !model.useResponsesLite ||
      value.settings.parallelToolCalls !== true,
    "Explicit parallel calls are unavailable on Responses Lite.",
  );
  const input = validateHistory(value.input, model);
  const names = new Set<string>();
  for (const tool of value.tools) {
    assert(
      tool.type === "function" &&
        /^[A-Za-z0-9_-]{1,64}$/.test(tool.name) &&
        !names.has(tool.name),
      "Invalid or duplicate function tool.",
    );
    names.add(tool.name);
    record(tool.parameters);
    validator(tool.parameters);
  }
  if (value.instructions)
    input.unshift({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: value.instructions }],
    });
  const request: ResponseRequest = {
    model: model.slug,
    stream: true,
    store: false,
    input,
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: model.useResponsesLite
      ? false
      : (value.settings.parallelToolCalls ?? true),
  };
  if (model.useResponsesLite && value.tools.length)
    input.unshift({
      type: "additional_tools",
      role: "developer",
      tools: [
        {
          type: "namespace",
          name: "functions",
          description: "",
          tools: value.tools,
        },
      ],
    });
  else if (!model.useResponsesLite) request.tools = value.tools;
  const s = value.settings;
  if (model.useResponsesLite || s.reasoningEffort || s.reasoningSummary)
    request.reasoning = {
      ...(model.useResponsesLite ? { context: "all_turns" } : {}),
      ...(s.reasoningEffort ? { effort: s.reasoningEffort } : {}),
      ...(s.reasoningSummary ? { summary: s.reasoningSummary } : {}),
    };
  if (s.verbosity) request.text = { verbosity: s.verbosity };
  if (value.format) {
    assert(!value.tools.length, "Direct schema cannot be combined with tools.");
    request.text = {
      ...request.text,
      format: validatedOutputFormat(value.format),
    };
  }
  if (s.serviceTier) request.service_tier = s.serviceTier;
  assert(
    Buffer.byteLength(JSON.stringify(request)) <= 32 * 1024 * 1024,
    "The request exceeds 32 MiB.",
  );
  return request;
}

export function sameCanonicalItem(a: ResponseItem, b: ResponseItem): boolean {
  const normalize = (item: ResponseItem) => {
    const copy = { ...item };
    delete copy.id;
    delete copy.status;
    return copy;
  };
  return isDeepStrictEqual(normalize(a), normalize(b));
}

/** Native RPC accepts the existing codec contract, never arbitrary provider options. */
export function validateNativeRequest(
  request: ResponseRequest,
  settings: ModelSettings,
  model: ModelInfo,
): void {
  const allowed = [
    "model",
    "stream",
    "store",
    "input",
    "include",
    "tool_choice",
    "parallel_tool_calls",
    "tools",
    "reasoning",
    "text",
    "service_tier",
    "prompt_cache_key",
  ];
  assert(
    Object.keys(request).every((key) => allowed.includes(key)),
    "Unsupported native request field.",
  );
  assert(
    request.prompt_cache_key === undefined ||
      (typeof request.prompt_cache_key === "string" &&
        /^[A-Za-z0-9_-]{1,256}$/.test(request.prompt_cache_key)),
    "Invalid native prompt affinity.",
  );
  assert(
    request.store === false &&
      request.stream === true &&
      request.model === model.slug &&
      request.tool_choice === "auto",
    "Invalid native request contract.",
  );
  assert(
    Array.isArray(request.include) &&
      request.include.every((value) => value === "reasoning.encrypted_content"),
    "Unsupported native include.",
  );
  assert(Array.isArray(request.input), "Native input must be an array.");
  let tools = request.tools ?? [];
  const namespaces = request.input.filter(
    (item) => item.type === "additional_tools",
  );
  assert(
    namespaces.length < 2 && (!namespaces.length || model.useResponsesLite),
    "Unexpected native tool namespace.",
  );
  if (namespaces.length) {
    const item = namespaces[0]!,
      groups = item.tools;
    assert(
      Object.keys(item).every((key) =>
        ["type", "role", "tools"].includes(key),
      ) &&
        item.role === "developer" &&
        Array.isArray(groups) &&
        groups.length === 1,
      "Invalid native tool namespace.",
    );
    const group = record(groups[0]);
    assert(
      group.type === "namespace" &&
        group.name === "functions" &&
        Array.isArray(group.tools),
      "Invalid native functions namespace.",
    );
    tools = group.tools as ProviderTool[];
  }
  canonicalRequest(
    {
      model: model.slug,
      input: request.input.filter((item) => item.type !== "additional_tools"),
      tools,
      settings,
      format: request.text?.format as StructuredFormat | undefined,
    },
    model,
    false,
  );
  assert(
    request.parallel_tool_calls ===
      (model.useResponsesLite ? false : (settings.parallelToolCalls ?? true)),
    "Native parallel-call settings do not match.",
  );
  if (request.reasoning) {
    const r = record(request.reasoning);
    assert(
      Object.keys(r).every((key) =>
        ["context", "effort", "summary"].includes(key),
      ) &&
        r.effort === settings.reasoningEffort &&
        r.summary === settings.reasoningSummary &&
        (model.useResponsesLite
          ? r.context === "all_turns"
          : r.context === undefined),
      "Native reasoning settings do not match.",
    );
  }
  if (request.text)
    assert(
      Object.keys(request.text).every((key) =>
        ["verbosity", "format"].includes(key),
      ) && request.text.verbosity === settings.verbosity,
      "Native text settings do not match.",
    );
  assert(
    request.service_tier === settings.serviceTier,
    "Native service tier does not match.",
  );
}
