import { isDeepStrictEqual } from "node:util";
import { assert, checkKeys, record } from "../core/errors.js";
import { jsonSnapshot } from "../core/snapshot.js";
import type { ProviderTool } from "../core/types.js";
import { validatedOutputFormat, validator, type StructuredFormat } from "./structured.js";

export type OutputContract =
  | { kind: "tools" }
  | { kind: "owned-function"; tool: ProviderTool }
  | { kind: "json"; format: StructuredFormat };

/** This descriptor belongs to a parser, never to arbitrary executable tools. */
export function validateOutputContract(value: unknown, tools: ProviderTool[], format?: StructuredFormat): OutputContract {
  if (value === undefined) return { kind: "tools" };
  const contract = record(value);
  if (contract.kind === "tools") {
    checkKeys(contract, ["kind"]);
    return { kind: "tools" };
  }
  if (contract.kind === "owned-function") {
    checkKeys(contract, ["kind", "tool"]);
    const tool = record(contract.tool);
    checkKeys(tool, ["type", "name", "description", "parameters", "strict"]);
    assert(tool.type === "function" && typeof tool.name === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(tool.name), "The owned structured function is invalid.");
    const snapshot = jsonSnapshot(JSON.parse(JSON.stringify(tool)), 128 * 1024) as ProviderTool;
    validator(record(snapshot.parameters));
    assert(!format && tools.length === 1 && isDeepStrictEqual(JSON.parse(JSON.stringify(tools[0])), snapshot), "The owned structured function cannot be overridden or combined with executable tools.");
    return { kind: "owned-function", tool: snapshot };
  }
  assert(contract.kind === "json", "The native output contract is unsupported.");
  checkKeys(contract, ["kind", "format"]);
  const snapshot = validatedOutputFormat(contract.format as StructuredFormat);
  assert(tools.length === 0 && isDeepStrictEqual(format, snapshot), "The owned JSON format cannot be overridden or combined with tools.");
  return { kind: "json", format: snapshot };
}
