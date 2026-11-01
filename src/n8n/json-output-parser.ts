import { BaseOutputParser, OutputParserException } from "@langchain/core/output_parsers";
import { assert, record } from "../core/errors.js";
import { jsonSnapshot } from "../core/snapshot.js";
import type { JsonObject } from "../core/types.js";
import { validator } from "../kernel/structured.js";

/** A native parser with first-error JSON Schema validation and no Zod conversion. */
export class CodexJsonOutputParser extends BaseOutputParser<JsonObject> {
  lc_namespace = ["codex_wire", "output_parsers"];
  private readonly outputSchema: JsonObject;
  private readonly validate;

  constructor(schema: unknown) {
    super();
    this.outputSchema = jsonSnapshot(record(schema));
    assert(
      this.outputSchema.type === "object",
      "Use an object JSON Schema for Codex Output Parser.",
    );
    this.validate = validator(this.outputSchema);
  }

  _type() {
    return "codex_json_schema";
  }
  getSchema(): JsonObject {
    return structuredClone(this.outputSchema);
  }
  getFormatInstructions(): string {
    return `Return one JSON object matching this JSON Schema. Do not add prose: ${JSON.stringify(this.outputSchema)}`;
  }

  async parse(text: string): Promise<JsonObject> {
    try {
      assert(
        typeof text === "string" && Buffer.byteLength(text) <= 4 * 1024 * 1024,
        "The structured response exceeds its size limit.",
      );
      let input = text.trim();
      if (input.startsWith("```")) {
        const newline = input.indexOf("\n");
        const opening = newline < 0 ? input : input.slice(0, newline).trimEnd();
        if (opening === "```" || opening === "```json") {
          assert(newline >= 0 && input.endsWith("\n```"), "The JSON fence is incomplete.");
          input = input.slice(newline + 1, -4);
        }
      }
      const value: unknown = JSON.parse(input);
      const pending = [{ value, depth: 0 }];
      let remaining = 65536;
      while (pending.length) {
        const current = pending.pop()!;
        assert(current.depth <= 64, "The structured response exceeds its depth limit.");
        if (current.value === null || typeof current.value !== "object") continue;
        if (Array.isArray(current.value)) {
          assert(
            current.value.length <= remaining,
            "The structured response exceeds its inspection budget.",
          );
          remaining -= current.value.length;
          for (let index = 0; index < current.value.length; index++)
            pending.push({ value: current.value[index], depth: current.depth + 1 });
        } else {
          for (const key in current.value) {
            if (!Object.hasOwn(current.value, key)) continue;
            assert(--remaining >= 0, "The structured response exceeds its inspection budget.");
            pending.push({ value: (current.value as JsonObject)[key], depth: current.depth + 1 });
          }
        }
      }
      assert(this.validate(value), "The structured response does not match its JSON Schema.");
      return record(value);
    } catch {
      throw new OutputParserException(
        "Codex Output Parser refused invalid or oversized JSON. No repair generation was requested by this parser.",
      );
    }
  }
}
