import {
  NodeConnectionTypes,
  NodeOperationError,
  type INodeType,
  type INodeTypeDescription,
  type ITriggerFunctions,
  type ITriggerResponse,
} from "n8n-workflow";
import { startNativeManager } from "../../service/native-manager.js";
import { safeError } from "../../core/errors.js";
import { testManagerCredential } from "../../service/native-local.js";
export class CodexWireService implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Codex Wire Service",
    name: "codexWireService",
    icon: "file:codex.svg",
    group: ["trigger"],
    version: 1,
    description: "Keep this workflow active to keep your Codex accounts available",
    defaults: { name: "Codex Wire Service" },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: "codexWireManager", required: true, testedBy: "testManager" }],
    properties: [
      {
        displayName:
          "Create and save a Codex Wire Manager credential, then activate this saved workflow. Keep one service active per Manager. Manage accounts with Codex Account in another workflow. Sharing the Manager delegates account administration. By wufflyne.com.",
        name: "notice",
        type: "notice",
        default: "",
      },
    ],
  };
  methods = { credentialTest: { testManager: testManagerCredential } };
  async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
    try {
      const manager = await startNativeManager(this);
      return {
        closeFunction: () => manager.close(),
        ...(this.getMode() === "manual"
          ? {
              manualTriggerFunction: async () => {
                this.emit([
                  [
                    {
                      json: {
                        status: "ready",
                        nextStep:
                          "Activate this saved workflow, then use Codex Account → Start Sign-in.",
                      },
                    },
                  ],
                ]);
              },
            }
          : {}),
      };
    } catch (error) {
      throw new NodeOperationError(this.getNode(), safeError(error).message);
    }
  }
}
