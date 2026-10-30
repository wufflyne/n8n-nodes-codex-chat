import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import {
  NodeConnectionTypes,
  NodeOperationError,
  type ISupplyDataFunctions,
  type IDataObject,
} from "n8n-workflow";
import { safeError } from "../core/errors.js";
function imageSummary(v: Record<string, unknown>): {
  mimeType: string | null;
  byteLength: number | null;
} {
  const url =
    typeof v.image_url === "string"
      ? v.image_url
      : v.image_url && typeof v.image_url === "object"
        ? (v.image_url as Record<string, unknown>).url
        : v.url;
  if (typeof url === "string" && url.startsWith("data:")) {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,/.exec(url);
    if (match) {
      const n = url.length - match[0].length,
        padding = url.endsWith("==") ? 2 : url.endsWith("=") ? 1 : 0;
      return {
        mimeType: match[1]!,
        byteLength: Math.max(0, Math.floor((n * 3) / 4) - padding),
      };
    }
  }
  if (v.data instanceof Uint8Array)
    return {
      mimeType:
        typeof v.mimeType === "string"
          ? v.mimeType
          : typeof v.mime_type === "string"
            ? v.mime_type
            : null,
      byteLength: v.data.byteLength,
    };
  if (typeof v.data === "string")
    return {
      mimeType:
        typeof v.mimeType === "string"
          ? v.mimeType
          : typeof v.mime_type === "string"
            ? v.mime_type
            : null,
      byteLength: Math.max(
        0,
        Math.floor((v.data.length * 3) / 4) -
          (v.data.endsWith("==") ? 2 : v.data.endsWith("=") ? 1 : 0),
      ),
    };
  return { mimeType: null, byteLength: null };
}
function content(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "[Unsupported content]";
  return value.map((v) =>
    v &&
    ["text", "input_text", "output_text"].includes(v.type) &&
    typeof v.text === "string"
      ? { type: "text", text: v.text }
      : v && ["image", "image_url", "input_image"].includes(v.type)
        ? {
            type: "image",
            detail: v.detail ?? v.image_url?.detail ?? "auto",
            ...imageSummary(v),
          }
        : { type: "unsupported" },
  );
}
function message(m: BaseMessage) {
  return {
    role: m.getType(),
    content: content(m.content),
    ...("tool_calls" in m ? { toolCalls: m.tool_calls } : {}),
    ...("tool_call_id" in m ? { toolCallId: m.tool_call_id } : {}),
  };
}
/** Only public n8n hooks; returned input indexes are authoritative. */
export class CodexTracing extends BaseCallbackHandler {
  name = "CodexWireTracing";
  #runs = new Map<string, number>();
  #ctx: ISupplyDataFunctions;
  #settings: { model: string; alias?: string };
  constructor(
    ctx: ISupplyDataFunctions,
    settings: { model: string; alias?: string },
  ) {
    super();
    this.#ctx = ctx;
    this.#settings = { ...settings };
    const cleanup = () => this.#runs.clear();
    ctx.onExecutionFinish!(cleanup);
    ctx.onExecutionCancellation(cleanup);
  }
  async handleChatModelStart(
    _llm: unknown,
    messages: BaseMessage[][],
    runId: string,
  ) {
    this.start(runId, {
      ...this.#settings,
      messages: messages.map((ms) => ms.map(message)),
    });
  }
  async handleLLMStart(_llm: unknown, prompts: string[], runId: string) {
    this.start(runId, { ...this.#settings, prompts });
  }
  private start(runId: string, data: unknown) {
    if (this.#runs.has(runId) || this.#runs.size >= 128) return;
    const result = this.#ctx.addInputData(NodeConnectionTypes.AiLanguageModel, [
      [{ json: data as IDataObject }],
    ]);
    this.#runs.set(runId, result.index);
  }
  async handleLLMEnd(output: LLMResult, runId: string) {
    const index = this.#runs.get(runId);
    if (index === undefined) return;
    this.#runs.delete(runId);
    const generations = output.generations.map((gs) =>
      gs.map((g) => {
        const m = "message" in g ? (g.message as BaseMessage) : undefined;
        return {
          text: g.text,
          ...(m
            ? {
                message: message(m),
                usage:
                  (m.response_metadata as Record<string, unknown>).usage ??
                  null,
                responseId:
                  (m.response_metadata as Record<string, unknown>).responseId ??
                  null,
              }
            : {}),
        };
      }),
    );
    this.#ctx.addOutputData(NodeConnectionTypes.AiLanguageModel, index, [
      [
        {
          json: {
            generations,
            model: this.#settings.model,
            alias: this.#settings.alias ?? null,
          } as unknown as IDataObject,
        },
      ],
    ]);
  }
  async handleLLMError(error: Error, runId: string) {
    const index = this.#runs.get(runId);
    if (index === undefined) return;
    this.#runs.delete(runId);
    const safe = safeError(error);
    this.#ctx.addOutputData(
      NodeConnectionTypes.AiLanguageModel,
      index,
      new NodeOperationError(this.#ctx.getNode(), safe.message),
    );
  }
}
