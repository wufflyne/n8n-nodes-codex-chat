import { isDeepStrictEqual } from "node:util";
import type { OutputContract } from "../../kernel/output-contract.js";
import { validator } from "../../kernel/structured.js";
export { validatedOutputFormat, type StructuredFormat } from "../../kernel/structured.js";
import { RunnableLambda, type Runnable } from "@langchain/core/runnables";
import type {
  BaseLanguageModelInput,
  StructuredOutputMethodOptions,
} from "@langchain/core/language_models/base";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { isInteropZodSchema, interopSafeParseAsync } from "@langchain/core/utils/types";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import { assert, CodexError, record } from "../../core/errors.js";
import { jsonSnapshot } from "../../core/snapshot.js";
import type { CodexCallOptions } from "../../model.js";
interface StructuredModel {
  bindTools(
    tools: CodexCallOptions["tools"],
    kwargs?: Partial<CodexCallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, CodexCallOptions>;
  withConfig(
    config: Partial<CodexCallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, CodexCallOptions>;
}
/** Refuse sparse parser results without changing legitimate Zod transformations. */
function assertDenseArrays(value: unknown): void {
  const pending = [{ value, depth: 0 }], seen = new WeakSet<object>();
  let remaining = 65536;
  while (pending.length) {
    const current = pending.pop()!;
    assert(current.depth <= 64, "The structured parser result exceeds its inspection depth.");
    const item = current.value;
    if (item === null || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) {
        assert(--remaining >= 0, "The structured parser result exceeds its inspection budget.");
        assert(Object.hasOwn(item, index), "The structured parser returned a sparse array.");
        pending.push({ value: item[index], depth: current.depth + 1 });
      }
    } else {
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        assert(--remaining >= 0, "The structured parser result exceeds its inspection budget.");
        pending.push({ value: (item as Record<string, unknown>)[key], depth: current.depth + 1 });
      }
    }
  }
}
export function structuredRunnable<T extends Record<string, unknown>>(
  model: StructuredModel,
  schema: unknown,
  config: StructuredOutputMethodOptions<boolean> = {},
): Runnable<BaseLanguageModelInput, T | { raw: BaseMessage; parsed: T | null }> {
  assert(
    config.method === undefined || ["functionCalling", "jsonSchema"].includes(config.method),
    "Use functionCalling or jsonSchema structured output; jsonMode is unsupported.",
  );
  assert(
    config.strict === undefined || typeof config.strict === "boolean",
    "Structured output strictness must be boolean.",
  );
  const zod = isInteropZodSchema(schema);
  let converted: unknown;
  try {
    converted = toJsonSchema(schema as Parameters<typeof toJsonSchema>[0]);
  } catch {
    throw new CodexError("configuration", "The output schema cannot be converted to JSON Schema.");
  }
  const snapshot = jsonSnapshot(record(converted)),
    validate = validator(snapshot),
    method = config.method ?? "functionCalling";
  const name =
    config.name ??
    (!zod && typeof snapshot.name === "string"
      ? snapshot.name
      : method === "jsonSchema"
        ? "codex_output_schema"
        : "extract");
  assert(
    /^[A-Za-z0-9_-]{1,64}$/.test(name),
    "The structured output name must be a valid function identifier.",
  );
  const format = { type: "json_schema" as const, name, strict: config.strict ?? true, schema: snapshot };
  const fn = {
    type: "function" as const, name,
    description: typeof snapshot.description === "string" ? snapshot.description : "Return the requested structured result.",
    parameters: snapshot,
    ...(config.strict === undefined ? {} : { strict: config.strict }),
  };
  const contract: OutputContract = method === "jsonSchema"
    ? { kind: "json", format } : { kind: "owned-function", tool: fn };
  const tools = [{ type: "function", function: { ...fn, type: undefined } }];
  delete tools[0]!.function.type;
  const bound = method === "jsonSchema"
    ? model.withConfig({ codexOutputContract: contract, codexOutputFormat: format })
    : model.bindTools(tools, { codexOutputContract: contract });
  return RunnableLambda.from(async (input: BaseLanguageModelInput, options) => {
    const supplied = options as CodexCallOptions;
    assert(supplied.codexOutputContract === undefined || isDeepStrictEqual(supplied.codexOutputContract, contract), "The owned structured output contract cannot be overridden.");
    assert(supplied.codexOutputFormat === undefined || (method === "jsonSchema" && isDeepStrictEqual(supplied.codexOutputFormat, format)), "The owned structured output format cannot be overridden.");
    assert(supplied.tools === undefined || isDeepStrictEqual(supplied.tools, method === "jsonSchema" ? [] : tools), "The owned structured output tools cannot be overridden.");
    const raw = await bound.invoke(input, options);
    // LangChain chunks discard invalid_tool_calls when no executable chunks exist.
    // Restore diagnostics only inside their owning parser, without creating tool calls.
    if (raw.response_metadata.ownedStructuredDiagnostic === true && Array.isArray(raw.additional_kwargs.codex_owned_diagnostics))
      raw.invalid_tool_calls = structuredClone(raw.additional_kwargs.codex_owned_diagnostics) as typeof raw.invalid_tool_calls;
    let parsed: T | null = null;
    try {
      assert(
        raw.response_metadata.ownedStructuredDiagnostic !== true,
        "The owned structured response did not satisfy its output contract.",
      );
      assert(
        raw.response_metadata.structuredInvalidArguments !== true,
        "The structured function arguments were not valid JSON.",
      );
      assert(
        raw.response_metadata.refusal !== true,
        "The provider refused this structured output.",
      );
      let value: unknown;
      if (method === "jsonSchema") {
        assert(
          !raw.tool_calls?.length && typeof raw.content === "string",
          "The direct structured response is not plain JSON text.",
        );
        try {
          value = JSON.parse(raw.content as string);
        } catch {
          throw new CodexError("protocol", "The structured response is not valid JSON.");
        }
      } else {
        assert(
          raw.tool_calls?.length === 1 && raw.tool_calls[0]?.name === name,
          "The structured response did not contain exactly the intended function call.",
        );
        value = raw.tool_calls[0]!.args;
      }
      if (zod) {
        const checked = await interopSafeParseAsync(schema, value);
        assert(checked.success, "The structured response did not satisfy its Zod schema.");
        value = checked.data;
        assertDenseArrays(value);
      } else assert(validate(value), "The structured response did not satisfy its JSON schema.");
      parsed = record(value) as T;
    } catch {
      raw.response_metadata = {
        ...raw.response_metadata,
        structuredParserStatus: "invalid_output",
      };
      if (!config.includeRaw)
        throw new CodexError(
          "protocol",
          "The structured response could not be parsed or did not satisfy its output schema.",
        );
    }
    return config.includeRaw ? { raw, parsed } : parsed!;
  });
}
