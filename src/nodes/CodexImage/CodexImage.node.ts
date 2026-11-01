import { nativeAccount } from "../../service/native-connections.js";
import {
  NodeConnectionTypes,
  NodeOperationError,
  type INodeType,
  type INodeTypeDescription,
  type IExecuteFunctions,
  type INodeExecutionData,
} from "n8n-workflow";
import { assert, safeError } from "../../core/errors.js";
import { nativeContext } from "../../n8n/context.js";
export class CodexImage implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Codex Image",
    name: "codexImage",
    icon: "file:codex.svg",
    group: ["transform"],
    version: 1,
    description: "Generate an image with your Codex account and return native binary",
    defaults: { name: "Codex Image" },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: "codexAccount", required: true }],
    properties: [
      {
        displayName:
          "Generates an image using your Codex account. Availability and allowance use depend on the provider. Automatic resets and account switching are unavailable for this action.",
        name: "notice",
        type: "notice",
        default: "",
      },
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        default: "generateImage",
        options: [{ name: "Generate Image", value: "generateImage" }],
        noDataExpression: true,
      },
      {
        displayName: "Prompt",
        name: "prompt",
        type: "string",
        typeOptions: { rows: 4 },
        default: "",
        required: true,
      },
      {
        displayName: "Transparent Background",
        name: "transparentBackground",
        type: "boolean",
        default: false,
      },
      {
        displayName: "Output Binary Property",
        name: "binaryProperty",
        type: "string",
        default: "data",
        required: true,
      },
      {
        displayName: "Options",
        name: "options",
        type: "collection",
        default: {},
        placeholder: "Add Option",
        options: [
          {
            displayName: "Overall Timeout (Seconds)",
            name: "timeoutSeconds",
            type: "number",
            default: 180,
            typeOptions: { minValue: 30, maxValue: 600 },
          },
        ],
      },
    ],
  };
  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const { service, binding } = await nativeAccount(this),
      result: INodeExecutionData[] = [];
    for (let i = 0; i < this.getInputData().length; i++)
      try {
        const property = this.getNodeParameter("binaryProperty", i, "data") as string;
        assert(
          /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(property),
          "Choose a valid output binary property.",
        );
        const options = this.getNodeParameter("options", i, {}) as {
          timeoutSeconds?: number;
        };
        const generated = await service.image(
          binding,
          this.getNodeParameter("prompt", i) as string,
          this.getNodeParameter("transparentBackground", i, false) === true,
          {
            signal: this.getExecutionCancelSignal(),
            context: nativeContext(this),
            timeoutMs: (options.timeoutSeconds ?? 180) * 1000,
          },
        );
        const binary = await this.helpers.prepareBinaryData(
          generated.bytes,
          generated.filename,
          generated.metadata.mimeType,
        );
        result.push({
          json: generated.metadata,
          binary: { [property]: binary },
          pairedItem: { item: i },
        });
      } catch (error) {
        throw new NodeOperationError(this.getNode(), safeError(error).message, {
          itemIndex: i,
        });
      }
    return [result];
  }
}
