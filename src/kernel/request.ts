import { isDeepStrictEqual } from "node:util";
import { normalizeImage, type ImageBudget } from "../image/validation.js";
import { validateSettings, validateReliability } from "../core/catalog.js";
import { assert, checkKeys, record, string } from "../core/errors.js";
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

import { validateReasoning } from "./completion.js";

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
            ...block,
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
      validateReasoning(item);
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

/** Cheap checks must precede session acquisition; capability checks follow model resolution. */
export function validateNativeShape(requestValue: unknown, settingsValue: unknown, lite: unknown): void {
  const request = record(requestValue), settings = record(settingsValue);
  checkKeys(request, ["model", "stream", "store", "input", "include", "tool_choice", "parallel_tool_calls", "tools", "reasoning", "text", "service_tier", "prompt_cache_key"]);
  checkKeys(settings, ["reasoningEffort", "reasoningSummary", "verbosity", "serviceTier", "parallelToolCalls", "timeoutMs", "idleTimeoutMs", "maxRetries"]);
  validateReliability(settings as unknown as ModelSettings);
  for (const key of ["reasoningEffort", "reasoningSummary", "verbosity", "serviceTier"])
    assert(settings[key] === undefined || (typeof settings[key] === "string" && (settings[key] as string).length > 0 && (settings[key] as string).length <= 200), "Native settings contain an invalid value.");
  assert(typeof lite === "boolean" && request.stream === true && request.store === false && request.tool_choice === "auto", "Invalid native privacy, stream or tool selection contract.");
  string(request.model, "Native model", 200);
  assert(Array.isArray(request.input) && Array.isArray(request.include) && request.include.length === 1 && request.include[0] === "reasoning.encrypted_content", "Native input and encrypted reasoning include are required.");
  assert(typeof request.parallel_tool_calls === "boolean", "Native parallel-call setting is required.");
  assert(request.prompt_cache_key === undefined || (typeof request.prompt_cache_key === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(request.prompt_cache_key)), "Invalid native prompt affinity.");
  assert(request.service_tier === undefined || typeof request.service_tier === "string", "Invalid native service tier.");
  if (request.reasoning !== undefined) {
    const reasoning = record(request.reasoning); checkKeys(reasoning, ["context", "effort", "summary"]);
    for (const value of Object.values(reasoning)) assert(value === undefined || typeof value === "string", "Invalid native reasoning setting.");
  }
  if (request.text !== undefined) {
    const text = record(request.text); checkKeys(text, ["verbosity", "format"]);
    assert(text.verbosity === undefined || typeof text.verbosity === "string", "Invalid native text setting.");
    if (text.format !== undefined) validatedOutputFormat(text.format as StructuredFormat);
  }
  const tools = (value: unknown) => {
    assert(Array.isArray(value), "Native tools must be an array.");
    for (const raw of value) {
      const tool = record(raw); checkKeys(tool, ["type", "name", "description", "parameters", "strict"]);
      assert(tool.type === "function" && typeof tool.name === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(tool.name) && (tool.description === undefined || typeof tool.description === "string") && (tool.strict === undefined || typeof tool.strict === "boolean"), "Invalid native function tool.");
      record(tool.parameters);
    }
  };
  if (request.tools !== undefined) tools(request.tools);
  for (const raw of request.input) {
    const item = record(raw);
    if (item.type === "additional_tools") {
      checkKeys(item, ["type", "role", "tools"]);
      assert(item.role === "developer" && Array.isArray(item.tools) && item.tools.length === 1, "Invalid native tool namespace.");
      const group = record(item.tools[0]); checkKeys(group, ["type", "name", "description", "tools"]);
      assert(group.type === "namespace" && group.name === "functions" && group.description === "", "Invalid native functions namespace.");
      tools(group.tools);
    }
  }
  assert(Buffer.byteLength(JSON.stringify(request)) <= 32 * 1024 * 1024, "The request exceeds 32 MiB.");
}

/** Normalize only documented equivalences in a comparison projection; forward the original request. */
export function validateNativeRequest(request: ResponseRequest, settings: ModelSettings, model: ModelInfo): void {
  validateNativeShape(request, settings, model.useResponsesLite);
  const namespaces = request.input.filter((item) => item.type === "additional_tools");
  assert(namespaces.length <= 1 && (!namespaces.length || model.useResponsesLite), "Unexpected native tool namespace.");
  assert(!model.useResponsesLite || request.tools === undefined, "Responses Lite cannot include ignored Standard tools.");
  const tools = namespaces.length
    ? record((namespaces[0]!.tools as unknown[])[0]).tools as ProviderTool[]
    : request.tools ?? [];
  const input = request.input.filter((item) => item.type !== "additional_tools");
  const canonical = canonicalRequest({ model: request.model, input, tools, settings, format: request.text?.format as StructuredFormat | undefined }, model, false);
  if (request.prompt_cache_key !== undefined) canonical.prompt_cache_key = request.prompt_cache_key;
  const projection = (value: ResponseRequest) => {
    const copy = JSON.parse(JSON.stringify(value)) as ResponseRequest;
    const callNames = new Map<string, unknown>();
    copy.input = copy.input.map((raw) => {
      const item = { ...raw };
      if (!item.type || item.type === "message") {
        item.type = "message";
        if (typeof item.content === "string") item.content = [{ type: item.role === "assistant" ? "output_text" : "input_text", text: item.content }];
        if (Array.isArray(item.content)) item.content = item.content.map((rawBlock) => {
          const block = record(rawBlock);
          return ["text", "input_text", "output_text"].includes(String(block.type)) ? { ...block, type: item.role === "assistant" ? "output_text" : "input_text" } : block;
        });
      }
      if (item.type === "function_call") {
        callNames.set(String(item.call_id), item.name);
        if (model.useResponsesLite && item.namespace === undefined) item.namespace = "functions";
      }
      if (model.useResponsesLite && item.type === "function_call_output") {
        if (item.name === undefined) item.name = callNames.get(String(item.call_id));
        if (item.namespace === undefined) item.namespace = "functions";
      }
      return item;
    });
    return copy;
  };
  assert(isDeepStrictEqual(projection(request), projection(canonical)), "Native request fields do not match the declared settings and codec. No request was rewritten or sent.");
}
