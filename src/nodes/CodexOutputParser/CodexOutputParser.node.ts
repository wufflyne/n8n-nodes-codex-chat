import {
  NodeConnectionTypes,
  NodeOperationError,
  type INodeType,
  type INodeTypeDescription,
  type ISupplyDataFunctions,
  type SupplyData,
} from "n8n-workflow";
import { CodexError } from "../../core/errors.js";
import { CodexJsonOutputParser } from "../../n8n/json-output-parser.js";

export class CodexOutputParser implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Codex Output Parser",
    name: "codexJsonOutputParser",
    icon: "file:codex.svg",
    group: ["transform"],
    version: 1,
    description:
      "Validate structured JSON with JSON Schema before returning native workflow output. By wufflyne.com.",
    defaults: { name: "Codex Output Parser" },
    inputs: [],
    outputs: [NodeConnectionTypes.AiOutputParser],
    outputNames: ["Output Parser"],
    properties: [
      {
        displayName:
          "Connect to a native AI Agent or Basic LLM Chain. Invalid responses stop the workflow; this parser makes no repair call.",
        name: "notice",
        type: "notice",
        default: "",
      },
      {
        displayName: "JSON Schema",
        name: "inputSchema",
        type: "json",
        required: true,
        default:
          '{\n  "type": "object",\n  "properties": { "answer": { "type": "string" } },\n  "required": ["answer"],\n  "additionalProperties": false\n}',
        description:
          "Use an object schema. Expressions are evaluated here in this node's native context; sub-node expressions use the first input item.",
      },
    ],
  };
  async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
    try {
      const raw = this.getNodeParameter("inputSchema", itemIndex);
      let schema: unknown;
      try {
        schema = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        throw new CodexError(
          "configuration",
          "Enter a valid object JSON Schema in Codex Output Parser.",
        );
      }
      return { response: new CodexJsonOutputParser(schema) };
    } catch (error) {
      throw new NodeOperationError(
        this.getNode(),
        error instanceof CodexError
          ? error.message
          : "Check the JSON Schema field or expression and the first input item in Codex Output Parser.",
      );
    }
  }
}
