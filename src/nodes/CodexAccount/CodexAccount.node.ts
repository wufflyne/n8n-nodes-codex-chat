import {
  connectionOperation,
  nativeAccount,
  nativeAccountStatus,
} from "../../service/native-connections.js";
import { editorResetCredits, testManagerCredential } from "../../service/native-local.js";
import {
  NodeConnectionTypes,
  NodeOperationError,
  type INodeType,
  type INodeTypeDescription,
  type IExecuteFunctions,
  type INodeExecutionData,
  type ILoadOptionsFunctions,
  type INodeListSearchResult,
} from "n8n-workflow";
import { assert, safeError } from "../../core/errors.js";
import { executionKey } from "../../core/affinity.js";
import { nativeContext } from "../../n8n/context.js";
import { DEFAULT_RECOVERY } from "../../account/types.js";
export class CodexAccount implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Codex Account",
    name: "codexAccountTools",
    icon: "file:codex.svg",
    group: ["transform"],
    version: 1,
    description: "Check your account, limits and earned reset allocations",
    defaults: { name: "Codex Account" },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      { name: "codexAccount", required: true },
      {
        name: "codexWireManager",
        required: true,
        testedBy: "testManager",
        displayOptions: {
          show: {
            operation: [
              "startSignIn",
              "completeSignIn",
              "cancelSignIn",
              "reconnect",
              "importSession",
            ],
          },
        },
      },
    ],
    properties: [
      {
        displayName:
          "Missing metadata means Email unavailable or Plan unavailable. Missing limits/balance remain unavailable; a null unit means Unit not reported. See checkedAt and freshness; usage may have changed.",
        name: "dataNotice",
        type: "notice",
        default: "",
        displayOptions: {
          show: {
            operation: ["checkAccount", "getLimits", "listResetCredits"],
          },
        },
      },
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        default: "checkAccount",
        noDataExpression: true,
        options: [
          { name: "Status", value: "checkAccount" },
          { name: "Start Sign-in", value: "startSignIn" },
          { name: "Complete Sign-in", value: "completeSignIn" },
          { name: "Cancel Sign-in", value: "cancelSignIn" },
          { name: "Reconnect", value: "reconnect" },
          { name: "Import Session", value: "importSession" },
          { name: "Refresh Limits", value: "getLimits" },
          { name: "Refresh Models", value: "getModels" },
          { name: "Get Execution Usage", value: "getExecutionUsage" },
          { name: "List Reset Credits", value: "listResetCredits" },
          { name: "Use Reset Credit", value: "useResetCredit" },
          { name: "Resolve Pending Reset", value: "resolvePendingReset" },
        ],
      },
      {
        displayName:
          "Device-code login is beta. Enable it in ChatGPT security settings or ask your workspace administrator. Select a saved Account and Manager, run Start Sign-in, use the provider's verification page, then run Complete Sign-in. Reconnect starts an independent sign-in and preserves the original verified account identity.",
        name: "connectionNotice",
        type: "notice",
        default: "",
        displayOptions: {
          show: { operation: ["startSignIn", "completeSignIn", "cancelSignIn", "reconnect"] },
        },
      },
      {
        displayName:
          "Paste session JSON only in the Manager credential's Advanced Session Import field, then save that credential and run this action. Never put tokens in workflow input or parameters. Clear the optional source field in the credential modal after successful import.",
        name: "importNotice",
        type: "notice",
        default: "",
        displayOptions: { show: { operation: ["importSession"] } },
      },
      {
        displayName: "Import Format",
        name: "importFormat",
        type: "options",
        default: "codex-auth-json",
        noDataExpression: true,
        options: [
          { name: "Codex Auth JSON", value: "codex-auth-json" },
          { name: "Explicit Codex Token Set", value: "token-set" },
        ],
        displayOptions: { show: { operation: ["importSession"] } },
      },
      {
        displayName: "Include Reset Details",
        name: "includeResetDetails",
        type: "boolean",
        default: false,
        displayOptions: { show: { operation: ["getLimits"] } },
        description:
          "Also requests finite earned-reset details. Read operations never consume them.",
      },
      {
        displayName: "Reset Credit",
        name: "resetCredit",
        type: "resourceLocator",
        default: { mode: "list", value: "" },
        required: true,
        displayOptions: { show: { operation: ["useResetCredit"] } },
        modes: [
          {
            displayName: "From List",
            name: "list",
            type: "list",
            typeOptions: {
              searchListMethod: "resetCredits",
              searchable: false,
            },
          },
          { displayName: "By ID", name: "id", type: "string" },
        ],
      },
      {
        displayName: "Allow This Step to Use One Reset Credit",
        name: "acknowledgement",
        type: "boolean",
        default: false,
        noDataExpression: true,
        displayOptions: { show: { operation: ["useResetCredit"] } },
        description:
          "This execution may consume one earned reset for this account. It does not buy credits.",
      },
      {
        displayName: "Maximum Resets per Account in 24 Hours",
        name: "maxPer24Hours",
        type: "number",
        default: 1,
        typeOptions: { minValue: 1, maxValue: 3 },
        displayOptions: { show: { operation: ["useResetCredit"] } },
        description:
          "Repeated or scheduled executions can use another allocation within this adapter’s rolling cap",
      },
      {
        displayName:
          "No additional allocation is selected. Reconciliation uses the exact pending action and may remain blocked after three unresolved attempts.",
        name: "reconcileNotice",
        type: "notice",
        default: "",
        displayOptions: { show: { operation: ["resolvePendingReset"] } },
      },
    ],
  };
  methods = {
    credentialTest: { testManager: testManagerCredential },
    listSearch: {
      async resetCredits(this: ILoadOptionsFunctions): Promise<INodeListSearchResult> {
        const credits = await editorResetCredits(this);
        return {
          results: credits
            .filter((e) => e.eligible)
            .map((e) => ({
              name: e.title ?? "Available reset",
              value: e.id,
              description: `${e.resetType} · ${e.expiresAt ? `Expires ${e.expiresAt}` : "No expiry reported"}`,
            })),
        };
      },
    },
  };
  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const operation = this.getNodeParameter("operation", 0) as string,
      items = this.getInputData();
    if (
      ["startSignIn", "completeSignIn", "cancelSignIn", "reconnect", "importSession"].includes(
        operation,
      )
    ) {
      assert(items.length === 1, "Connection actions accept one input item only.");
      try {
        const result = await connectionOperation(
          this,
          operation,
          this.getNodeParameter("importFormat", 0, "codex-auth-json") as
            | "codex-auth-json"
            | "token-set",
          this.getExecutionCancelSignal(),
        );
        return [[{ json: result, pairedItem: { item: 0 } }]];
      } catch (error) {
        throw new NodeOperationError(this.getNode(), safeError(error).message);
      }
    }
    if (operation === "checkAccount") {
      try {
        const statuses: INodeExecutionData[] = [];
        for (let i = 0; i < items.length; i++)
          statuses.push({
            json: (await nativeAccountStatus(this)) as INodeExecutionData["json"],
            pairedItem: { item: i },
          });
        return [statuses];
      } catch (error) {
        throw new NodeOperationError(this.getNode(), safeError(error).message);
      }
    }
    assert(
      !["useResetCredit", "resolvePendingReset"].includes(operation) || items.length === 1,
      "Reset actions accept one input item only.",
    );
    const { binding, service } = await nativeAccount(this),
      results: INodeExecutionData[] = [];
    for (let i = 0; i < items.length; i++)
      try {
        let value: unknown;
        const signal = this.getExecutionCancelSignal();
        if (operation === "getExecutionUsage") {
          value = await service.usage(binding, nativeContext(this));
        } else if (operation === "getModels") {
          const models = await service.models(binding, signal, true),
            account = await service.status(binding);
          value = {
            schemaVersion: 1,
            operation,
            checkedAt: new Date().toISOString(),
            account: account.account,
            models,
          };
        } else if (operation === "getLimits" || operation === "listResetCredits") {
          value = await service.limits(binding, {
            force: true,
            signal,
            includeResetDetails:
              operation === "listResetCredits" ||
              this.getNodeParameter("includeResetDetails", i, false) === true,
          });
          (value as { operation: string }).operation = operation;
        } else if (operation === "useResetCredit")
          value = await service.reset(
            binding,
            {
              origin: "manual",
              executionKey: executionKey(nativeContext(this)),
              selectedCreditId: this.getNodeParameter("resetCredit", i, "", {
                extractValue: true,
              }) as string,
              acknowledgement: this.getNodeParameter("acknowledgement", i, false) === true,
              policy: {
                ...DEFAULT_RECOVERY,
                maxPer24Hours: this.getNodeParameter("maxPer24Hours", i, 1) as number,
              },
              signal,
            },
            nativeContext(this),
          );
        else if (operation === "resolvePendingReset")
          value = await service.reconcile(
            binding,
            {
              executionKey: executionKey(nativeContext(this)),
              signal,
            },
            nativeContext(this),
          );
        else assert(false, "Choose a supported Codex Account operation.");
        results.push({
          json: value as INodeExecutionData["json"],
          pairedItem: { item: i },
        });
      } catch (error) {
        throw new NodeOperationError(this.getNode(), safeError(error).message, {
          itemIndex: i,
        });
      }
    return [results];
  }
}
