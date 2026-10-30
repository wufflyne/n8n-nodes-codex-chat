import { createHash } from "node:crypto";
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
import { credentialBinding, runtime } from "../../runtime.js";
import { assert, safeError } from "../../core/errors.js";
import { executionKey } from "../../core/affinity.js";
import { executionUsage } from "../../core/execution-usage.js";
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
    credentials: [{ name: "codexAccount", required: true }],
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
          { name: "Check Account", value: "checkAccount" },
          { name: "Get Limits", value: "getLimits" },
          { name: "Get Models", value: "getModels" },
          { name: "Get Execution Usage", value: "getExecutionUsage" },
          { name: "List Reset Credits", value: "listResetCredits" },
          { name: "Use Reset Credit", value: "useResetCredit" },
          { name: "Resolve Pending Reset", value: "resolvePendingReset" },
        ],
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
    listSearch: {
      async resetCredits(
        this: ILoadOptionsFunctions,
      ): Promise<INodeListSearchResult> {
        const snapshot = await runtime().account.readAccount(
          credentialBinding(await this.getCredentials("codexAccount")),
          { force: true, includeResetDetails: true },
        );
        return {
          results: snapshot.resetCredits.entries
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
    assert(
      !["useResetCredit", "resolvePendingReset"].includes(operation) ||
        items.length === 1,
      "Reset actions accept one input item only.",
    );
    const binding = credentialBinding(
        await this.getCredentials("codexAccount"),
      ),
      rt = runtime(),
      results: INodeExecutionData[] = [];
    for (let i = 0; i < items.length; i++)
      try {
        let value: unknown;
        const signal = this.getExecutionCancelSignal();
        if (operation === "checkAccount")
          value = await rt.account.readLocalStatus(binding);
        else if (operation === "getExecutionUsage") {
          const profile = await rt.store.read(binding),
            affinity = createHash("sha256")
              .update(`${profile.id}:${profile.subject}:${profile.accountId}`)
              .digest("hex");
          value = executionUsage(nativeContext(this), affinity);
        } else if (operation === "getModels") {
          const session = await rt.sessions.session(binding, signal),
            models = await rt.catalog.list(session, signal, true),
            account = await rt.account.readLocalStatus(binding);
          value = {
            schemaVersion: 1,
            operation,
            checkedAt: new Date().toISOString(),
            account: account.account,
            models,
          };
        } else if (
          operation === "getLimits" ||
          operation === "listResetCredits"
        ) {
          value = await rt.account.readAccount(binding, {
            force: true,
            signal,
            includeResetDetails:
              operation === "listResetCredits" ||
              this.getNodeParameter("includeResetDetails", i, false) === true,
          });
          (value as { operation: string }).operation = operation;
        } else if (operation === "useResetCredit")
          value = await rt.resets.consumeReset(binding, {
            origin: "manual",
            executionKey: executionKey(nativeContext(this)),
            selectedCreditId: this.getNodeParameter("resetCredit", i, "", {
              extractValue: true,
            }) as string,
            acknowledgement:
              this.getNodeParameter("acknowledgement", i, false) === true,
            policy: {
              ...DEFAULT_RECOVERY,
              maxPer24Hours: this.getNodeParameter(
                "maxPer24Hours",
                i,
                1,
              ) as number,
            },
            signal,
          });
        else if (operation === "resolvePendingReset")
          value = await rt.resets.resolvePendingReset(binding, {
            executionKey: executionKey(nativeContext(this)),
            signal,
          });
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
