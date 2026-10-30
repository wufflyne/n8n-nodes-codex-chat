import {
  NodeConnectionTypes,
  NodeOperationError,
  type ICredentialTestFunctions,
  type ICredentialsDecrypted,
  type ICredentialDataDecryptedObject,
  type ILoadOptionsFunctions,
  type INodeCredentialTestResult,
  type INodeListSearchResult,
  type INodeProperties,
  type INodePropertyOptions,
  type INodeType,
  type INodeTypeDescription,
  type ISupplyDataFunctions,
  type SupplyData,
} from "n8n-workflow";
import { CodexChatModel as ChatModel } from "../../model.js";
import { localStatus } from "../../auth/status.js";
import { nativeContext } from "../../n8n/context.js";
import { CodexTracing } from "../../n8n/tracing.js";
import {
  promptCacheProperty,
  recoveryProperty,
  recoveryPolicy,
} from "../../n8n/options.js";
import type { AffinityPolicy } from "../../core/affinity.js";
import { ReplayLedger } from "../../core/replay.js";
import { assert } from "../../core/errors.js";
import { credentialBinding, runtime } from "../../runtime.js";
import { safeError } from "../../core/errors.js";
import type { ModelSettings } from "../../core/types.js";

const executionReplays = new Map<string, ReplayLedger>();

async function selectedModel(ctx: ILoadOptionsFunctions) {
  const binding = credentialBinding(await ctx.getCredentials("codexAccount"));
  const rt = runtime();
  const session = await rt.sessions.session(binding);
  const parameter = ctx.getNodeParameter("model", "") as
    | { value?: string }
    | string;
  const slug =
    typeof parameter === "string" ? parameter : (parameter.value ?? "");
  return rt.catalog.model(session, slug);
}

const reliability: INodeProperties = {
  displayName: "Reliability",
  name: "reliability",
  type: "collection",
  default: {},
  placeholder: "Add Reliability Option",
  options: [
    {
      displayName: "Overall Timeout (Seconds)",
      name: "timeoutSeconds",
      type: "number",
      default: 300,
      typeOptions: { minValue: 1, maxValue: 3600 },
      description:
        "Includes account renewal, catalog loading, admission retries, and the response stream",
    },
    {
      displayName: "Stream Idle Timeout (Seconds)",
      name: "idleSeconds",
      type: "number",
      default: 90,
      typeOptions: { minValue: 1, maxValue: 3600 },
      description:
        "Maximum time without provider bytes; must not exceed the overall timeout",
    },
    {
      displayName: "Retry Attempts",
      name: "maxRetries",
      type: "number",
      default: 2,
      typeOptions: { minValue: 0, maxValue: 5 },
      description:
        "Retries only HTTP 429/503 rejections before generation begins. An accepted or interrupted response is never replayed.",
    },
    {
      displayName: "Parallel Tool Calls",
      name: "parallelToolCalls",
      type: "boolean",
      default: true,
      description:
        "Whether to allow parallel tool calls on the standard Responses route. Responses Lite uses its native automatic tool selection.",
    },
  ],
};

export class CodexChatModel implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Codex Chat Model",
    name: "codexChatModel",
    icon: "file:codex.svg",
    group: ["transform"],
    version: 1,
    description:
      "An independent, experimental Codex subscription integration for self-hosted n8n.",
    defaults: { name: "Codex Chat Model" },
    inputs: [],
    outputs: [NodeConnectionTypes.AiLanguageModel],
    outputNames: ["Model"],
    codex: {
      categories: ["AI"],
      subcategories: {
        AI: ["Language Models"],
        "Language Models": ["Chat Models"],
      },
    },
    credentials: [
      { name: "codexAccount", required: true, testedBy: "testProfileBinding" },
    ],
    properties: [
      {
        displayName:
          "Uses an experimental Codex API. Available models and limits depend on your account.",
        name: "experimentalNotice",
        type: "notice",
        default: "",
      },
      {
        displayName: "Model",
        name: "model",
        type: "resourceLocator",
        default: { mode: "list", value: "" },
        required: true,
        description:
          "Choose from this account's catalog. Inference access is checked when the workflow runs. Picker data is cached up to five minutes; use Codex Account → Get Models to refresh.",
        modes: [
          {
            displayName: "From List",
            name: "list",
            type: "list",
            placeholder: "Choose a model…",
            typeOptions: { searchListMethod: "searchModels", searchable: true },
          },
          {
            displayName: "By ID",
            name: "id",
            type: "string",
            placeholder: "Model identifier from this account catalog",
          },
        ],
      },
      {
        displayName: "Reasoning",
        name: "reasoning",
        type: "collection",
        default: {},
        placeholder: "Add Reasoning Option",
        options: [
          {
            displayName: "Effort",
            name: "effort",
            type: "options",
            default: "",
            typeOptions: {
              loadOptionsMethod: "reasoningEfforts",
              loadOptionsDependsOn: ["model"],
            },
            description:
              "Only efforts advertised by the selected model are available",
          },
          {
            displayName: "Summary",
            name: "summary",
            type: "options",
            default: "",
            typeOptions: {
              loadOptionsMethod: "reasoningSummaries",
              loadOptionsDependsOn: ["model"],
            },
            description:
              "A provider-generated reasoning summary, when supported; never raw chain of thought",
          },
        ],
      },
      {
        displayName: "Speed",
        name: "speed",
        type: "options",
        default: "",
        typeOptions: {
          loadOptionsMethod: "serviceTiers",
          loadOptionsDependsOn: ["model"],
        },
        description:
          "Only tiers advertised for this account and model. Faster tiers may consume additional subscription allowance.",
      },
      {
        displayName: "Output",
        name: "output",
        type: "collection",
        default: {},
        placeholder: "Add Output Option",
        options: [
          {
            displayName: "Verbosity",
            name: "verbosity",
            type: "options",
            default: "",
            typeOptions: {
              loadOptionsMethod: "verbosityLevels",
              loadOptionsDependsOn: ["model"],
            },
            description:
              "Controls answer detail when advertised by the model. For structured output, use the AI Agent output parser.",
          },
        ],
      },
      reliability,
      promptCacheProperty,
      recoveryProperty(),
    ],
  };

  methods = {
    listSearch: {
      async searchModels(
        this: ILoadOptionsFunctions,
        filter?: string,
      ): Promise<INodeListSearchResult> {
        const rt = runtime();
        const session = await rt.sessions.session(
          credentialBinding(await this.getCredentials("codexAccount")),
        );
        const models = await rt.catalog.list(session);
        return {
          results: models
            .filter(
              (m) =>
                !filter ||
                `${m.name} ${m.slug}`
                  .toLowerCase()
                  .includes(filter.toLowerCase()),
            )
            .map((m) => ({
              name: m.name,
              value: m.slug,
              description: [
                m.description,
                m.contextWindow
                  ? `${m.contextWindow.toLocaleString("en-US")} token context`
                  : "Context not advertised",
                m.defaultReasoningEffort
                  ? `Advertised effort default: ${m.defaultReasoningEffort}`
                  : undefined,
              ]
                .filter(Boolean)
                .join(" · "),
            })),
        };
      },
    },
    loadOptions: {
      async reasoningEfforts(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        return [
          { name: "Provider Default (No Override)", value: "" },
          ...(await selectedModel(this)).reasoningEfforts.map((e) => ({
            name: e[0]!.toUpperCase() + e.slice(1),
            value: e,
          })),
        ];
      },
      async reasoningSummaries(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        return [
          { name: "Provider Default (No Override)", value: "" },
          ...((await selectedModel(this)).supportsSummary
            ? ["auto", "concise", "detailed"].map((s) => ({
                name: s[0]!.toUpperCase() + s.slice(1),
                value: s,
              }))
            : []),
        ];
      },
      async serviceTiers(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        return [
          { name: "Account Default (No Override)", value: "" },
          ...(await selectedModel(this)).serviceTiers.map((t) => ({
            name: t.name,
            value: t.id,
          })),
        ];
      },
      async verbosityLevels(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        return [
          { name: "Provider Default (No Override)", value: "" },
          ...((await selectedModel(this)).supportsVerbosity
            ? ["low", "medium", "high"].map((s) => ({
                name: s[0]!.toUpperCase() + s.slice(1),
                value: s,
              }))
            : []),
        ];
      },
    },
    credentialTest: {
      async testProfileBinding(
        this: ICredentialTestFunctions,
        credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
      ): Promise<INodeCredentialTestResult> {
        try {
          const profile = await runtime().store.read(
            credentialBinding(credential.data),
          );
          const status = localStatus(
            profile,
            runtime().sessions.refreshEnabled,
          );
          if (
            profile.tokens.expiresAt <= Date.now() &&
            status.account.renewal !== "enabled"
          )
            return {
              status: "Error",
              message:
                "This session has expired and automatic renewal is unavailable. Reconnect this profile with the account helper.",
            };
          if (profile.state !== "ready")
            return {
              status: "Error",
              message:
                "This profile requires reconnection with the account helper.",
            };
          const renewal =
            status.account.renewal === "disabled_by_instance"
              ? "Automatic renewal is disabled for this instance."
              : status.account.renewal === "access_only"
                ? "This is an access-token-only session. Reconnect it when it expires."
                : "Automatic renewal is enabled for this exclusively managed profile.";
          return {
            status: "OK",
            message: `Profile binding verified locally. ${renewal} Inference access is checked when the workflow runs.`,
          };
        } catch (error) {
          return { status: "Error", message: safeError(error).message };
        }
      },
    },
  };

  async supplyData(
    this: ISupplyDataFunctions,
    itemIndex: number,
  ): Promise<SupplyData> {
    try {
      const binding = credentialBinding(
        await this.getCredentials("codexAccount"),
      );
      const rt = runtime();
      const context = nativeContext(this);
      assert(
        this.onExecutionFinish,
        "This n8n runtime lacks the execution cleanup hook required for native tool replay.",
      );
      const key = JSON.stringify([
        context.instanceId,
        context.workflowId,
        context.executionId,
        context.nodeId,
        binding.profileId,
      ]);
      let replay = executionReplays.get(key);
      if (!replay) {
        assert(
          executionReplays.size < 128,
          "Too many active Codex model executions. Retry after existing runs finish.",
        );
        replay = new ReplayLedger();
        executionReplays.set(key, replay);
        const cleanup = () => {
          replay!.clear();
          executionReplays.delete(key);
        };
        this.onExecutionFinish(cleanup);
        this.onExecutionCancellation(cleanup);
      }
      const model = this.getNodeParameter("model", itemIndex, "", {
        extractValue: true,
      }) as string;
      const reasoning = this.getNodeParameter("reasoning", itemIndex, {}) as {
        effort?: string;
        summary?: string;
      };
      const output = this.getNodeParameter("output", itemIndex, {}) as {
        verbosity?: string;
      };
      const reliabilityOptions = this.getNodeParameter(
        "reliability",
        itemIndex,
        {},
      ) as {
        timeoutSeconds?: number;
        idleSeconds?: number;
        maxRetries?: number;
        parallelToolCalls?: boolean;
      };
      const settings: Partial<ModelSettings> = {
        reasoningEffort: reasoning.effort || undefined,
        reasoningSummary: reasoning.summary || undefined,
        verbosity: output.verbosity || undefined,
        serviceTier:
          (this.getNodeParameter("speed", itemIndex, "") as string) ||
          undefined,
        timeoutMs: (reliabilityOptions.timeoutSeconds ?? 300) * 1000,
        idleTimeoutMs: (reliabilityOptions.idleSeconds ?? 90) * 1000,
        maxRetries: reliabilityOptions.maxRetries ?? 2,
        parallelToolCalls: reliabilityOptions.parallelToolCalls ?? true,
      };
      const cache = this.getNodeParameter("promptCache", itemIndex, {}) as {
        affinity?: AffinityPolicy["mode"];
        conversationKey?: string;
      };
      const chat = new ChatModel({
        model,
        session: (signal) => rt.sessions.session(binding, signal),
        catalog: rt.catalog,
        transport: rt.transport,
        settings,
        replay,
        context,
        candidateKey: binding.profileId,
        affinityPolicy: {
          mode: cache.affinity ?? "execution",
          conversationKey: cache.conversationKey,
        },
        account: {
          binding,
          reader: rt.account,
          reset: rt.resets,
          policy: recoveryPolicy(
            this.getNodeParameter("accountRecovery", itemIndex, {}),
          ),
        },
        executionSignal: this.getExecutionCancelSignal(),
      });
      chat.callbacks = [
        new CodexTracing(this, { model, alias: this.getNode().name }),
      ];
      return { response: chat };
    } catch (error) {
      throw new NodeOperationError(this.getNode(), safeError(error).message);
    }
  }
}
