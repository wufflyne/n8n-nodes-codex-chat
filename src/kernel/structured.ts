import Ajv, { type ValidateFunction } from "ajv";
import { AsyncLocalStorage } from "node:async_hooks";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { assert, CodexError, record } from "../core/errors.js";
import { jsonSnapshot } from "../core/snapshot.js";
import type { JsonObject } from "../core/types.js";
export interface StructuredFormat {
  type: "json_schema";
  name: string;
  strict: boolean;
  schema: JsonObject;
}
const sharedSchemas = new Map<string, ValidateFunction>();
const privateSchemas = new AsyncLocalStorage<Map<string, ValidateFunction>>();
/** Stateless Responses retain schema text and validator errors only within their request. */
export function withSchemaScope<T>(stateless: boolean, action: () => T): T {
  if (!stateless || privateSchemas.getStore()) return action();
  const schemas = new Map<string, ValidateFunction>();
  return privateSchemas.run(schemas, () => {
    try {
      const result = action();
      if (result instanceof Promise)
        return result.finally(() => schemas.clear()) as T;
      schemas.clear();
      return result;
    } catch (error) {
      schemas.clear();
      throw error;
    }
  });
}
export function validator(schema: JsonObject): ValidateFunction {
  const compiled = privateSchemas.getStore() ?? sharedSchemas;
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
