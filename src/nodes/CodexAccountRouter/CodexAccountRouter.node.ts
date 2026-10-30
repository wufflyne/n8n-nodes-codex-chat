import {
  NodeConnectionTypes,
  NodeOperationError,
  type INodeType,
  type INodeTypeDescription,
  type ISupplyDataFunctions,
  type SupplyData,
} from "n8n-workflow";
import { assert, safeError } from "../../core/errors.js";
import { nativeContext } from "../../n8n/context.js";
import {
  promptCacheProperty,
  recoveryProperty,
  recoveryPolicy,
} from "../../n8n/options.js";
import { coordinator, clearCoordinator } from "../../routing/coordinator.js";
import { CodexAccountRouterModel } from "../../routing/model.js";
import type { AffinityPolicy } from "../../core/affinity.js";
export class CodexAccountRouter implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Codex Account Router",
    name: "codexAccountRouter",
    icon: "file:codex.svg",
    group: ["transform"],
    version: 1,
    description: "Select an account for one fresh native Agent invocation",
    defaults: { name: "Codex Account Router" },
    inputs:
      '={{ Array.from({length:$parameter.numberAccounts || 2}, (_, i) => ({type:"ai_languageModel",displayName:String(i + 1),required:true,maxConnections:1})) }}',
    outputs: [NodeConnectionTypes.AiLanguageModel],
    outputNames: ["Model"],
    properties: [
      {
        displayName:
          "Selects an account for a fresh Agent invocation. The account stays fixed after the provider accepts a request.",
        name: "scopeNotice",
        type: "notice",
        default: "",
      },
      {
        displayName: "Number of Accounts",
        description: "Input 1 is Account 1, input 2 is Account 2, and so on. Accounts are tried in numeric input order.",
        name: "numberAccounts",
        type: "options",
        default: 2,
        noDataExpression: true,
        options: [2, 3, 4, 5].map((n) => ({ name: String(n), value: n })),
      },
      {
        displayName: "Consumer Agent Name",
        name: "consumerAgent",
        type: "string",
        default: "AI Agent",
        required: true,
        noDataExpression: true,
        description:
          "Exact native AI Agent name. Use one fresh invocation; attached memory and native Fallback are unsupported.",
      },
      {
        displayName: "Unknown Limits",
        name: "unknownLimits",
        type: "options",
        default: "try",
        options: [
          { name: "Try in Order", value: "try" },
          { name: "Stop", value: "stop" },
        ],
      },
      promptCacheProperty,
      recoveryProperty(true),
    ],
  };
  async supplyData(
    this: ISupplyDataFunctions,
    itemIndex: number,
  ): Promise<SupplyData> {
    try {
      const context = nativeContext(this),
        consumer = this.getNodeParameter(
          "consumerAgent",
          itemIndex,
          "AI Agent",
        ) as string;
      const parents = this.getParentNodes(consumer, {
        connectionType: NodeConnectionTypes.AiLanguageModel,
        depth: 1,
      });
      assert(
        parents.some((p) => p.name === this.getNode().name),
        "The declared consumer must directly connect to this Account Router.",
      );
      const proxy = this.getWorkflowDataProxy(itemIndex),
        node = proxy.$node[consumer];
      assert(node, "The declared consumer Agent is unavailable.");
      const parameters = node.parameter;
      assert(
        parameters && typeof parameters === "object",
        "The declared consumer Agent parameters are unavailable.",
      );
      assert(
        parameters.needsFallback !== true,
        "Disable native Agent Fallback when using Account Router.",
      );
      assert(
        this.getParentNodes(consumer, {
          connectionType: NodeConnectionTypes.AiMemory,
          depth: 1,
        }).length === 0,
        "Account Router requires a fresh Agent without attached memory. Use account-scoped memory with Model Selector.",
      );
      const connected = await this.getInputConnectionData(
        NodeConnectionTypes.AiLanguageModel,
        itemIndex,
      );
      assert(
        Array.isArray(connected),
        "Connect the ordered Codex Chat Model inputs.",
      );
      const candidates = [...connected].reverse();
      assert(
        candidates.length ===
          this.getNodeParameter("numberAccounts", itemIndex, 2),
        "Connect exactly one Codex Chat Model to every Account input.",
      );
      const entry = coordinator(context);
      if (entry.created) {
        const cleanup = () => clearCoordinator(context);
        this.onExecutionFinish!(cleanup);
        this.onExecutionCancellation(cleanup);
      }
      const cache = this.getNodeParameter("promptCache", itemIndex, {}) as {
        affinity?: AffinityPolicy["mode"];
        conversationKey?: string;
      };
      let traceIndex: number | undefined;
      return {
        response: new CodexAccountRouterModel({
          candidates,
          onSummary: (summary) => {
            if (traceIndex === undefined) {
              traceIndex = this.addInputData(
                NodeConnectionTypes.AiLanguageModel,
                [
                  [
                    {
                      json: {
                        selection: "ordered_accounts",
                        scope: "fresh_invocation",
                      },
                    },
                  ],
                ],
              ).index;
            } else
              this.addOutputData(
                NodeConnectionTypes.AiLanguageModel,
                traceIndex,
                [[{ json: summary }]],
              );
          },
          coordinator: entry.value,
          context,
          unknownLimits: this.getNodeParameter(
            "unknownLimits",
            itemIndex,
            "try",
          ) as "try" | "stop",
          policy: recoveryPolicy(
            this.getNodeParameter("accountRecovery", itemIndex, {}),
          ),
          affinityPolicy: {
            mode: cache.affinity ?? "execution",
            conversationKey: cache.conversationKey,
          },
          signal: this.getExecutionCancelSignal(),
        }),
      };
    } catch (error) {
      throw new NodeOperationError(this.getNode(), safeError(error).message);
    }
  }
}
