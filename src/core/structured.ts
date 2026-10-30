import Ajv, { type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { RunnableLambda, type Runnable } from "@langchain/core/runnables";
import type {
  BaseLanguageModelInput,
  StructuredOutputMethodOptions,
} from "@langchain/core/language_models/base";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import {
  isInteropZodSchema,
  interopSafeParseAsync,
} from "@langchain/core/utils/types";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import { assert, CodexError, record } from "./errors.js";
import { jsonSnapshot } from "./snapshot.js";
import type { JsonObject } from "./types.js";
import type { CodexCallOptions } from "../model.js";
export interface StructuredFormat {
  type: "json_schema";
  name: string;
  strict: boolean;
  schema: JsonObject;
}
const compiled = new Map<string, ValidateFunction>();
function validator(schema: JsonObject): ValidateFunction {
  const key = JSON.stringify(schema);
  const existing = compiled.get(key);
  if (existing) return existing;
  const scan = (v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return;
    const node = v as JsonObject;
    assert(
      node.$async === undefined,
      "Async schema validation is unsupported.",
    );
    for (const k of ["$ref", "$dynamicRef"]) {
      const x = node[k];
      if (x !== undefined)
        assert(
          typeof x === "string" && x.startsWith("#"),
          "Remote JSON schema references are unsupported.",
        );
    }
    // Walk schema positions only. Property names and const/default/example data are literals.
    for (const k of [
      "properties",
      "patternProperties",
      "definitions",
      "$defs",
      "dependentSchemas",
      "dependencies",
    ])
      if (node[k] && typeof node[k] === "object" && !Array.isArray(node[k]))
        Object.values(node[k] as JsonObject).forEach(scan);
    for (const k of ["allOf", "anyOf", "oneOf", "prefixItems"])
      if (Array.isArray(node[k])) (node[k] as unknown[]).forEach(scan);
    for (const k of [
      "additionalProperties",
      "unevaluatedProperties",
      "propertyNames",
      "contains",
      "not",
      "if",
      "then",
      "else",
      "additionalItems",
      "unevaluatedItems",
      "contentSchema",
    ])
      scan(node[k]);
    if (Array.isArray(node.items)) node.items.forEach(scan);
    else scan(node.items);
  };
  scan(schema);
  const draft = schema.$schema;
  assert(
    draft === undefined ||
      draft === "http://json-schema.org/draft-07/schema#" ||
      draft === "https://json-schema.org/draft/2020-12/schema",
    "Use JSON Schema draft-07 or 2020-12.",
  );
  const options = {
    allErrors: false,
    strict: true,
    logger: false as const,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    validateFormats: true,
  };
  try {
    const ajv =
      draft === "https://json-schema.org/draft/2020-12/schema"
        ? new Ajv2020(options)
        : new Ajv(options);
    addFormats(ajv);
    const validate = ajv.compile(schema);
    if (compiled.size >= 64) compiled.delete(compiled.keys().next().value!);
    compiled.set(key, validate);
    return validate;
  } catch {
    throw new CodexError(
      "configuration",
      "The output schema could not be compiled with the supported local validator.",
    );
  }
}
export function validatedOutputFormat(
  value: StructuredFormat,
): StructuredFormat {
  assert(
    value &&
      value.type === "json_schema" &&
      typeof value.name === "string" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(value.name) &&
      typeof value.strict === "boolean" &&
      Object.keys(value).every((k) =>
        ["type", "name", "strict", "schema"].includes(k),
      ),
    "The direct structured output option is invalid.",
  );
  const schema = jsonSnapshot(record(value.schema));
  validator(schema);
  return Object.freeze({
    type: "json_schema",
    name: value.name,
    strict: value.strict,
    schema,
  });
}
interface StructuredModel {
  bindTools(
    tools: CodexCallOptions["tools"],
    kwargs?: Partial<CodexCallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, CodexCallOptions>;
  withConfig(
    config: Partial<CodexCallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, CodexCallOptions>;
}
export function structuredRunnable<T extends Record<string, unknown>>(
  model: StructuredModel,
  schema: unknown,
  config: StructuredOutputMethodOptions<boolean> = {},
): Runnable<
  BaseLanguageModelInput,
  T | { raw: BaseMessage; parsed: T | null }
> {
  assert(
    config.method === undefined ||
      ["functionCalling", "jsonSchema"].includes(config.method),
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
    throw new CodexError(
      "configuration",
      "The output schema cannot be converted to JSON Schema.",
    );
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
  const bound =
    method === "jsonSchema"
      ? model.withConfig({
          codexStructuredOutput: true,
          codexOutputFormat: {
            type: "json_schema",
            name,
            strict: config.strict ?? true,
            schema: snapshot,
          },
        })
      : model.bindTools(
          [
            {
              type: "function",
              function: {
                name,
                description:
                  typeof snapshot.description === "string"
                    ? snapshot.description
                    : "Return the requested structured result.",
                parameters: snapshot,
                ...(config.strict === undefined
                  ? {}
                  : { strict: config.strict }),
              },
            },
          ],
          { codexStructuredOutput: true },
        );
  return RunnableLambda.from(async (input: BaseLanguageModelInput, options) => {
    const raw = await bound.invoke(input, options);
    let parsed: T | null = null;
    try {
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
          throw new CodexError(
            "protocol",
            "The structured response is not valid JSON.",
          );
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
        assert(
          checked.success,
          "The structured response did not satisfy its Zod schema.",
        );
        value = checked.data;
      } else
        assert(
          validate(value),
          "The structured response did not satisfy its JSON schema.",
        );
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
