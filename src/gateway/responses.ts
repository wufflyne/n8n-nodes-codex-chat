import { randomUUID } from "node:crypto";
import { record } from "../core/errors.js";
import type { CanonicalGeneration } from "../kernel/request.js";
import type {
  CompletedResponse,
  ProviderTool,
  ResponseItem,
} from "../core/types.js";
import { invalid, terminal } from "./errors.js";
import type { StateRepository, StateWrite } from "./state/repository.js";
import { sameCanonicalItem } from "../kernel/request.js";
import { gatewayMemory, type MemoryLease } from "./pool/memory.js";
import { validator, withSchemaScope } from "../kernel/structured.js";
import { assertHistoryScope, type HistoryScope } from "./state/history-scope.js";

export interface ResponsesInput extends Omit<CanonicalGeneration, "input"> {
  input: ResponseItem[];
  stream: boolean;
  store: boolean;
}
function keys(value: Record<string, unknown>, allowed: string[], prefix = "") {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) invalid(prefix + key);
}
export function parseResponses(value: unknown): ResponsesInput {
  const body = record(value);
  return withSchemaScope(body.store === false, () => parseBody(body));
}
function parseBody(body: Record<string, unknown>): ResponsesInput {
  keys(body, [
    "model",
    "input",
    "instructions",
    "stream",
    "store",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "reasoning",
    "text",
    "service_tier",
    "include",
    "metadata",
  ]);
  if (typeof body.model !== "string" || !body.model || body.model.length > 200)
    invalid("model");
  if (body.instructions !== undefined && typeof body.instructions !== "string")
    invalid("instructions");
  for (const key of ["stream", "store", "parallel_tool_calls"])
    if (body[key] !== undefined && typeof body[key] !== "boolean") invalid(key);
  if (
    body.tool_choice !== undefined &&
    body.tool_choice !== null &&
    body.tool_choice !== "auto"
  )
    invalid("tool_choice");
  if (
    body.include !== undefined &&
    (!Array.isArray(body.include) ||
      body.include.some((v) => v !== "reasoning.encrypted_content"))
  )
    invalid("include");
  if (body.metadata !== undefined) {
    const m = record(body.metadata);
    if (
      Object.keys(m).length > 16 ||
      Object.entries(m).some(
        ([k, v]) => k.length > 64 || typeof v !== "string" || v.length > 512,
      )
    )
      invalid("metadata");
  }
  const input =
    typeof body.input === "string"
      ? [{ type: "message", role: "user", content: body.input }]
      : body.input;
  if (!Array.isArray(input) || input.length > 10000) invalid("input");
  for (let i = 0; i < input.length; i++) {
    const item = record(input[i]),
      prefix = `input[${i}].`;
    if (item.type === "item_reference") {
      keys(item, ["type", "id"], prefix);
      if (typeof item.id !== "string") invalid(prefix + "id");
    } else if (!item.type || item.type === "message")
      keys(item, ["type", "id", "role", "content", "status", "phase"], prefix);
    else if (item.type === "reasoning")
      keys(
        item,
        ["type", "id", "summary", "encrypted_content", "status"],
        prefix,
      );
    else if (item.type === "function_call")
      keys(
        item,
        ["type", "id", "call_id", "name", "arguments", "status"],
        prefix,
      );
    else if (item.type === "function_call_output")
      keys(item, ["type", "call_id", "output", "status"], prefix);
    else invalid(prefix + "type");
  }
  const rawTools = body.tools ?? [];
  if (!Array.isArray(rawTools) || rawTools.length > 256) invalid("tools");
  const tools: ProviderTool[] = rawTools.map((raw, i) => {
    const t = record(raw);
    keys(
      t,
      ["type", "name", "description", "parameters", "strict"],
      `tools[${i}].`,
    );
    if (
      t.type !== "function" ||
      typeof t.name !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(t.name)
    )
      invalid(`tools[${i}]`);
    if (t.description !== undefined && typeof t.description !== "string")
      invalid(`tools[${i}].description`);
    if (t.strict != null && typeof t.strict !== "boolean")
      invalid(`tools[${i}].strict`);
    const parameters = record(
      t.parameters ?? { type: "object", properties: {} },
    );
    try {
      validator(parameters);
    } catch {
      invalid(
        `tools[${i}].parameters`,
        "The function schema is not supported by the local validator.",
      );
    }
    return {
      type: "function",
      name: t.name,
      parameters,
      ...(t.description ? { description: String(t.description) } : {}),
      ...(typeof t.strict === "boolean" ? { strict: t.strict } : {}),
    };
  });
  const reasoning = body.reasoning == null ? {} : record(body.reasoning),
    text = body.text == null ? {} : record(body.text);
  keys(reasoning, ["effort", "summary"], "reasoning.");
  keys(text, ["verbosity", "format"], "text.");
  for (const [param, v] of [
    ["reasoning.effort", reasoning.effort],
    ["reasoning.summary", reasoning.summary],
    ["text.verbosity", text.verbosity],
    ["service_tier", body.service_tier],
  ])
    if (v != null && (typeof v !== "string" || v.length > 64))
      invalid(String(param));
  let format: CanonicalGeneration["format"];
  if (text.format != null) {
    const f = record(text.format);
    keys(
      f,
      ["type", "name", "strict", "schema", "description"],
      "text.format.",
    );
    if (f.type !== "json_schema") invalid("text.format.type");
    if (f.description !== undefined)
      invalid(
        "text.format.description",
        "Descriptions in direct schema formats are not qualified for this subscription route.",
      );
    format = f as unknown as CanonicalGeneration["format"];
    if (tools.length)
      invalid(
        "text.format",
        "Direct JSON schema cannot be combined with tools.",
      );
  }
  return {
    model: body.model,
    input: input as ResponseItem[],
    instructions: body.instructions as string | undefined,
    tools,
    format,
    stream: body.stream === true,
    store: body.store !== false,
    settings: {
      timeoutMs: 300000,
      idleTimeoutMs: 90000,
      maxRetries: 0,
      ...(body.parallel_tool_calls === undefined
        ? {}
        : { parallelToolCalls: body.parallel_tool_calls as boolean }),
      ...(reasoning.effort
        ? { reasoningEffort: String(reasoning.effort) }
        : {}),
      ...(reasoning.summary
        ? { reasoningSummary: String(reasoning.summary) }
        : {}),
      ...(text.verbosity ? { verbosity: String(text.verbosity) } : {}),
      ...(body.service_tier ? { serviceTier: String(body.service_tier) } : {}),
    },
  };
}

interface HistoryEntry extends HistoryScope {
  canonical: ResponseItem;
  public: ResponseItem;
  created: number;
}
export const HISTORY_IDLE = 30 * 86400000,
  HISTORY_ABSOLUTE = 90 * 86400000;
export class ItemResolver {
  private readonly memory = gatewayMemory;
  constructor(
    private readonly state: StateRepository,
    readonly limits = {
      expandedBytes: 8 * 1024 * 1024,
      recordBytes: 4 * 1024 * 1024,
      references: 256,
    },
    readonly retention = { idleDays: 30, absoluteDays: 90 },
  ) {}
  scope(connection: string) {
    return this.state.scope("history", connection);
  }
  async resolve(
    connection: string,
    scope: HistoryScope,
    items: ResponseItem[],
    stored: boolean,
  ): Promise<ResponseItem[]> {
    const result = await this.resolveAdmitted(
      connection,
      scope,
      items,
      stored,
    );
    try {
      return result.items;
    } finally {
      result.release();
    }
  }
  async resolveAdmitted(
    connection: string,
    scope: HistoryScope,
    items: ResponseItem[],
    stored: boolean,
    signal?: AbortSignal,
    requestLease?: MemoryLease,
  ) {
    const owner = this.scope(connection),
      result: ResponseItem[] = [];
    const keys = items.map((raw) => {
      if (
        !stored &&
        (raw.type === "item_reference" ||
          (typeof raw.id === "string" && raw.id.startsWith("item_cw_")) ||
          (typeof raw.call_id === "string" && raw.call_id.startsWith("call_cw_")))
      )
        terminal(
          "stored_dependency",
          "store:false requires complete inline provider history; retained item and call handles are not allowed.",
        );
      let key: string | undefined;
      if (raw.type === "item_reference") key = String(raw.id);
      else if (
        stored &&
        raw.type === "function_call_output" &&
        String(raw.call_id).startsWith("call_cw_")
      )
        key = `call:${raw.call_id}`;
      else if (
        stored &&
        raw.type === "function_call" &&
        String(raw.call_id).startsWith("call_cw_")
      )
        key = `call:${raw.call_id}`;
      else if (
        stored &&
        typeof raw.id === "string" &&
        raw.id.startsWith("item_cw_")
      )
        key = raw.id;
      return key;
    });
    const references = keys.filter((key): key is string => !!key);
    if (references.length > this.limits.references)
      terminal("expanded_history_limit", "Too many local history references.");
    const metadata = await this.state.metadata(owner, references);
    let expandedBytes = Buffer.byteLength(JSON.stringify(items));
    for (const m of metadata) {
      if (!m)
        terminal(
          "history_expired",
          "Local history is unavailable or expired. Start a new conversation with complete history.",
        );
      if (m.bytes > this.limits.recordBytes)
        terminal(
          "expanded_history_limit",
          "A stored item exceeds the per-item memory limit.",
        );
      expandedBytes += m.bytes;
    }
    if (expandedBytes > this.limits.expandedBytes)
      terminal(
        "expanded_history_limit",
        "The expanded canonical history exceeds the request memory limit.",
      );
    // Account for decrypted JSON, parsed worker objects, IPC clones, canonical input and serialization.
    if (signal?.aborted)
      terminal(
        "cancelled",
        "The request was cancelled before history expansion.",
      );
    const release = requestLease
      ? requestLease.tryExtend(6 * expandedBytes)
      : this.memory.tryAcquireBytes(6 * expandedBytes);
    try {
      let referenceIndex = 0;
      for (const [index, raw] of items.entries()) {
        const key = keys[index];
        if (!key) {
          result.push(structuredClone(raw));
          continue;
        }
        const meta = metadata[referenceIndex++]!;
        const entry = await this.state.get<HistoryEntry>(owner, key, {
          bytes: meta.bytes,
          revision: meta.revision,
        });
        if (!entry || entry.expires <= Date.now())
          terminal(
            "history_expired",
            "Local history is unavailable or expired. Start a new conversation with complete history.",
          );
        const v = entry.value;
        assertHistoryScope(v, scope);
        if (raw.type === "function_call_output")
          result.push({ ...raw, call_id: v.canonical.call_id });
        else {
          if (
            raw.type !== "item_reference" &&
            !sameCanonicalItem(raw, v.public)
          )
            terminal(
              "history_conflict",
              "Inline history differs from its canonical stored item.",
            );
          result.push(structuredClone(v.canonical));
        }
      }
      await this.state.touch(
        owner,
        [...new Set(references)],
        this.retention.idleDays * 86400000,
        this.retention.absoluteDays * 86400000,
      );
      return { items: result, release };
    } catch (error) {
      release();
      throw error;
    }
  }
  prepare(
    connection: string,
    scope: HistoryScope,
    response: CompletedResponse,
    stored: boolean,
    identity?: { responseId: string; items: Map<string, string> },
  ) {
    const owner = this.scope(connection),
      writes: StateWrite[] = [],
      now = Date.now();
    const output = response.output.map((raw) => {
      const canonical = structuredClone(raw),
        item = structuredClone(raw);
      if (item.type === "agent_message") item.type = "message";
      if (stored)
        item.id =
          identity?.items.get(String(raw.id)) ??
          `item_cw_${randomUUID().replaceAll("-", "")}`;
      else item.id ??= `item_${randomUUID().replaceAll("-", "")}`;
      if (item.type === "message") {
        item.role = "assistant";
        item.status = "completed";
        item.content = (Array.isArray(item.content) ? item.content : []).map(
          (v) => {
            const b = record(v);
            return b.type === "refusal"
              ? { type: "refusal", refusal: b.refusal }
              : { type: "output_text", text: b.text, annotations: [] };
          },
        );
      }
      if (item.type === "function_call") {
        item.status = "completed";
        delete item.namespace;
        if (stored)
          item.call_id = `call_cw_${randomUUID().replaceAll("-", "")}`;
      }
      if (item.type === "reasoning") {
        item.summary ??= [];
        item.status = "completed";
      }
      if (stored) {
        const value: HistoryEntry = {
          ...scope,
          canonical,
          public: item,
          created: now,
        };
        writes.push({
          owner,
          id: item.id!,
          value,
          expires: now + this.retention.idleDays * 86400000,
        });
        if (item.type === "function_call")
          writes.push({
            owner,
            id: `call:${item.call_id}`,
            value,
            expires: now + this.retention.idleDays * 86400000,
          });
      }
      return item;
    });
    return {
      body: {
        id:
          identity?.responseId ?? `resp_cw_${randomUUID().replaceAll("-", "")}`,
        object: "response",
        created_at: Math.floor(now / 1000),
        status: "completed",
        model: scope.model,
        output,
        usage: response.usage ?? null,
        error: null,
        incomplete_details: null,
        store: stored,
      },
      writes,
    };
  }
}

/** Emit executable arguments only from a previously committed, fully validated result. */
export function* responseEvents(
  body: ReturnType<ItemResolver["prepare"]>["body"],
): Generator<Record<string, unknown>> {
  let sequence = 0;
  const event = (type: string, data: Record<string, unknown>) => ({
    type,
    sequence_number: sequence++,
    ...data,
  });
  const initial = { ...body, status: "in_progress", output: [], usage: null };
  yield event("response.created", { response: initial });
  yield event("response.in_progress", { response: initial });
  for (let i = 0; i < body.output.length; i++) {
    const item = body.output[i]!;
    const header = {
      ...item,
      status: "in_progress",
      ...(item.type === "message" ? { content: [] } : {}),
      ...(item.type === "function_call" ? { arguments: "" } : {}),
      ...(item.type === "reasoning"
        ? { summary: [], encrypted_content: null }
        : {}),
    };
    yield event("response.output_item.added", {
      output_index: i,
      item: header,
    });
    if (item.type === "message")
      for (const [index, part] of (
        item.content as Array<Record<string, unknown>>
      ).entries()) {
        yield event("response.content_part.added", {
          item_id: item.id,
          output_index: i,
          content_index: index,
          part: {
            ...part,
            ...(part.type === "refusal" ? { refusal: "" } : { text: "" }),
          },
        });
        const refusal = part.type === "refusal",
          field = refusal ? "refusal" : "text";
        yield event(
          refusal ? "response.refusal.delta" : "response.output_text.delta",
          {
            item_id: item.id,
            output_index: i,
            content_index: index,
            delta: part[field],
          },
        );
        yield event(
          refusal ? "response.refusal.done" : "response.output_text.done",
          {
            item_id: item.id,
            output_index: i,
            content_index: index,
            [field]: part[field],
          },
        );
        yield event("response.content_part.done", {
          item_id: item.id,
          output_index: i,
          content_index: index,
          part,
        });
      }
    if (item.type === "reasoning")
      for (const [index, part] of (
        item.summary as Array<Record<string, unknown>>
      ).entries()) {
        yield event("response.reasoning_summary_part.added", {
          item_id: item.id,
          output_index: i,
          summary_index: index,
          part: { type: "summary_text", text: "" },
        });
        yield event("response.reasoning_summary_text.delta", {
          item_id: item.id,
          output_index: i,
          summary_index: index,
          delta: part.text,
        });
        yield event("response.reasoning_summary_text.done", {
          item_id: item.id,
          output_index: i,
          summary_index: index,
          text: part.text,
        });
        yield event("response.reasoning_summary_part.done", {
          item_id: item.id,
          output_index: i,
          summary_index: index,
          part,
        });
      }
    if (item.type === "function_call") {
      yield event("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: i,
        delta: item.arguments,
      });
      yield event("response.function_call_arguments.done", {
        item_id: item.id,
        output_index: i,
        name: item.name,
        arguments: item.arguments,
      });
    }
    yield event("response.output_item.done", { output_index: i, item });
  }
  yield event("response.completed", { response: body });
}
