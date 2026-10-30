import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type {
  BaseLanguageModelInput,
  StructuredOutputMethodOptions,
} from "@langchain/core/language_models/base";
import type { Runnable } from "@langchain/core/runnables";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { ReplayLedger } from "./core/replay.js";
import {
  ModelCatalog,
  validateReliability,
  validateSettings,
} from "./core/catalog.js";
import {
  boundToolsSnapshot,
  buildRequest,
  outputMessage,
  toolRegistry,
} from "./core/codec.js";
import { approximateTextTokens } from "./core/token-estimate.js";
import {
  affinityKey,
  executionKey,
  type ExecutionContext,
  type AffinityPolicy,
} from "./core/affinity.js";
import { recordInvocation, type CallRecorder } from "./core/execution-usage.js";
import { normalizeUsage } from "./core/usage.js";
import { validateCompletion } from "./kernel/completion.js";
import {
  structuredRunnable,
  validatedOutputFormat,
  type StructuredFormat,
} from "./core/structured.js";
import { CODEX_CANDIDATE, type CodexCandidate } from "./routing/candidate.js";
import type { Binding } from "./core/types.js";
import type { AccountReader } from "./account/usage.js";
import type { ResetController } from "./account/reset.js";
import type { RecoveryPolicy } from "./account/types.js";
import { lowAllowance } from "./account/reset-policy.js";
import { AdmissionRejection, type TransportContext } from "./core/transport.js";
import { assert } from "./core/errors.js";
import { requestScope, waitForSignal } from "./core/http.js";
import { ResponsesTransport } from "./core/transport.js";
import type { ModelInfo, ModelSettings, Session } from "./core/types.js";

export interface CodexCallOptions extends BaseChatModelCallOptions {
  tools?: BindToolsInput[];
  parallel_tool_calls?: boolean;
  abortSignal?: AbortSignal;
  codexOutputFormat?: StructuredFormat;
  /** Owned structured parser path; invalid calls are raw diagnostics and never executed. */
  codexStructuredOutput?: boolean;
}

export interface CodexModelOptions {
  model: string;
  session: (signal?: AbortSignal) => Promise<Session>;
  catalog: ModelCatalog;
  transport: ResponsesTransport;
  settings?: Partial<ModelSettings>;
  executionSignal?: AbortSignal;
  replay?: ReplayLedger;
  context?: ExecutionContext;
  affinityPolicy?: AffinityPolicy;
  transportContext?: TransportContext;
  account?: {
    binding: Binding;
    reader: AccountReader;
    reset: ResetController;
    policy: RecoveryPolicy;
  };
  candidateKey?: string;
  recorder?: CallRecorder;
}

export const DEFAULT_SETTINGS: ModelSettings = {
  timeoutMs: 300000,
  idleTimeoutMs: 90000,
  maxRetries: 2,
  parallelToolCalls: true,
};

/** Build and validate the complete local request before any automatic credit action. */
function prepareRequest(
  messages: BaseMessage[],
  model: ModelInfo,
  settings: ModelSettings,
  session: Session,
  options: CodexCallOptions,
  config: Pick<CodexModelOptions, "replay" | "context" | "affinityPolicy">,
) {
  assert(
    !options.stop?.length,
    "Stop sequences are unsupported by this subscription route.",
  );
  validateReliability(settings);
  validateSettings(model, settings);
  const registry = toolRegistry(options.tools);
  const request = buildRequest(
    messages,
    model,
    settings,
    registry,
    session,
    options.tool_choice,
    config.replay,
  );
  if (options.codexOutputFormat) {
    assert(
      !registry.tools.length,
      "Direct JSON schema output cannot be combined with tools.",
    );
    request.text = {
      ...request.text,
      format: validatedOutputFormat(options.codexOutputFormat),
    };
  }
  const affinity = affinityKey(
    config.context,
    session,
    model.slug,
    model.useResponsesLite ? "responses-lite" : "responses",
    config.affinityPolicy,
  );
  if (affinity) request.prompt_cache_key = affinity;
  assert(
    Buffer.byteLength(JSON.stringify(request)) <= 32 * 1024 * 1024,
    "The conversation exceeds the 32 MiB request limit.",
  );
  return { registry, request, affinity };
}

/** One generation per call. n8n owns the agent loop, tool execution and memory. */
export class CodexChatModel extends BaseChatModel<CodexCallOptions> {
  lc_serializable = false;
  #config: CodexModelOptions;
  private affinity?: string;
  constructor(options: CodexModelOptions) {
    super({ maxRetries: 0 });
    this.#config = {
      ...options,
      settings: { ...options.settings },
      context: options.context
        ? Object.freeze({ ...options.context })
        : undefined,
      affinityPolicy: options.affinityPolicy
        ? Object.freeze({ ...options.affinityPolicy })
        : undefined,
    };
    Object.defineProperty(this, CODEX_CANDIDATE, {
      enumerable: false,
      value: () => this.candidate(),
    });
  }
  _llmType(): string {
    return "codex-subscription-experimental";
  }
  get lc_secrets(): Record<string, string> {
    return { session: "CODEX_ACCOUNT_SESSION" };
  }
  _identifyingParams(): Record<string, unknown> {
    return { model: this.#config.model, provider: this._llmType() };
  }

  bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<CodexCallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, CodexCallOptions> {
    return this.withConfig({ ...kwargs, tools: boundToolsSnapshot(tools) });
  }

  async getNumTokens(content: BaseMessage["content"]): Promise<number> {
    return approximateTextTokens(content);
  }

  withStructuredOutput<T extends Record<string, any> = Record<string, any>>(
    schema: any,
    config?: StructuredOutputMethodOptions<false>,
  ): Runnable<BaseLanguageModelInput, T>;
  withStructuredOutput<T extends Record<string, any> = Record<string, any>>(
    schema: any,
    config?: StructuredOutputMethodOptions<true>,
  ): Runnable<BaseLanguageModelInput, { raw: BaseMessage; parsed: T }>;
  withStructuredOutput<T extends Record<string, any> = Record<string, any>>(
    schema: any,
    config: StructuredOutputMethodOptions<boolean> = {},
  ): any {
    return structuredRunnable<T>(this, schema, config);
  }

  private candidate(): CodexCandidate {
    const config = this.#config,
      account = config.account;
    return Object.freeze({
      key: config.candidateKey ?? "",
      model: config.model,
      settings: { ...DEFAULT_SETTINGS, ...config.settings },
      autoReset: account?.policy.automatic ?? false,
      callbacks: this.callbacks,
      resolve: async (signal?: AbortSignal) => {
        const session = await config.session(signal);
        const model = await config.catalog.model(session, config.model, signal);
        validateSettings(model, { ...DEFAULT_SETTINGS, ...config.settings });
        return { session, model };
      },
      read: async (signal?: AbortSignal, force = false) => {
        assert(account, "This model has no native account reader.");
        return account.reader.readAccount(account.binding, {
          signal,
          force,
          model: config.model,
        });
      },
      readAfterRejection: async (signal?: AbortSignal) => {
        assert(account, "This model has no native account reader.");
        return account.reader.readAccount(account.binding, {
          signal,
          afterRejection: true,
          model: config.model,
        });
      },
      validateInput: (...args: Parameters<CodexCandidate["validateInput"]>) => {
        const [messages, options, selected, overrides] = args;
        const settings = {
          ...DEFAULT_SETTINGS,
          ...config.settings,
          ...(options.parallel_tool_calls === undefined
            ? {}
            : { parallelToolCalls: options.parallel_tool_calls }),
        };
        prepareRequest(
          messages,
          selected.model,
          settings,
          selected.session,
          options,
          {
            ...config,
            ...overrides,
          },
        );
      },
      recover: async (policy: RecoveryPolicy, signal?: AbortSignal) => {
        assert(
          account && config.context,
          "This model has no native reset execution context.",
        );
        return account.reset.consumeReset(account.binding, {
          origin: "automatic",
          executionKey: executionKey(config.context),
          policy,
          signal,
        });
      },
      clone: (overrides: Partial<CodexModelOptions>) => {
        const clone = new CodexChatModel({ ...config, ...overrides });
        clone.callbacks = this.callbacks;
        return clone;
      },
    });
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    let combined: ChatGenerationChunk | undefined;
    for await (const chunk of this._streamResponseChunks(
      messages,
      options,
      runManager,
    ))
      combined = combined ? combined.concat(chunk) : chunk;
    assert(combined, "The provider returned no completed generation.");
    return {
      generations: [{ text: combined.text, message: combined.message }],
      llmOutput: combined.generationInfo,
    };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    assert(
      !options.stop?.length,
      "Stop sequences are unsupported by this subscription route.",
    );
    const settings = {
      ...DEFAULT_SETTINGS,
      ...this.#config.settings,
      ...(options.parallel_tool_calls === undefined
        ? {}
        : { parallelToolCalls: options.parallel_tool_calls }),
    };
    validateReliability(settings);
    const scope = requestScope(
      [options.signal, options.abortSignal, this.#config.executionSignal],
      settings.timeoutMs,
    );
    const started = performance.now();
    const deadline = Math.min(
      this.#config.transportContext?.deadline ?? Infinity,
      Date.now() + settings.timeoutMs,
    );
    let recorder: CallRecorder | undefined;
    try {
      const session = await waitForSignal(
        this.#config.session(scope.signal),
        scope.signal,
      );
      this.affinity ??= session.affinity;
      assert(
        this.affinity === session.affinity,
        "The account changed during this Agent run. Restart with a separate account and memory session.",
      );
      const model = await this.#config.catalog.model(
        session,
        this.#config.model,
        scope.signal,
      );
      const account = this.#config.account;
      const { registry, request, affinity } = prepareRequest(
        messages,
        model,
        settings,
        session,
        options,
        this.#config,
      );
      if (account?.policy.automatic) {
        assert(
          this.#config.context,
          "Automatic account recovery requires a public execution context.",
        );
        const snapshot = await account.reader.readAccount(account.binding, {
          signal: scope.signal,
          model: model.slug,
        });
        if (lowAllowance(snapshot, account.policy)) {
          const reset = await account.reset.consumeReset(account.binding, {
            origin: "automatic",
            executionKey: executionKey(this.#config.context),
            policy: account.policy,
            signal: scope.signal,
          });
          assert(
            reset.action.state !== "uncertain",
            "The reset outcome is unknown. No other reset will be used for this account until the pending action is resolved.",
          );
        }
      }
      recorder =
        this.#config.recorder ??
        recordInvocation(
          this.#config.context,
          session.affinity,
          model.slug,
          model.useResponsesLite ? "responses-lite" : "responses",
        );
      let streamedText = "";
      const transportContext: TransportContext = {
        ...this.#config.transportContext,
        deadline,
        affinity,
        recorder,
      };
      if (account?.policy.automatic && !transportContext.onRejection)
        transportContext.onRejection = async (_r, signal) => {
          const snapshot = await account.reader.readAccount(account.binding, {
            afterRejection: true,
            signal,
            model: model.slug,
          });
          return snapshot.routing.decision === "quota_exhausted"
            ? "quota"
            : "retry";
        };
      const events = async function* (modelInstance: CodexChatModel) {
        let recovered = false;
        while (true) {
          try {
            yield* modelInstance.#config.transport.stream(
              request,
              session,
              settings,
              [scope.signal],
              model.useResponsesLite,
              transportContext,
            );
            break;
          } catch (error) {
            if (
              !(error instanceof AdmissionRejection) ||
              !account?.policy.automatic ||
              recovered
            )
              throw error;
            recovered = true;
            assert(
              modelInstance.#config.context,
              "Automatic recovery requires execution identity.",
            );
            const reset = await account.reset.consumeReset(account.binding, {
              origin: "automatic",
              executionKey: executionKey(modelInstance.#config.context),
              policy: account.policy,
              signal: scope.signal,
            });
            assert(
              reset.action.state !== "uncertain",
              "The reset outcome is unknown. No other reset will be used for this account until the pending action is resolved.",
            );
            assert(
              reset.action.recovery === "allowed",
              "This account cannot continue the current tool turn. Start a new execution to use another account.",
            );
            recorder?.postReset();
          }
        }
      };
      const eventStream = account?.policy.automatic
        ? events(this)
        : this.#config.transport.stream(
            request,
            session,
            settings,
            [scope.signal],
            model.useResponsesLite,
            transportContext,
          );
      for await (const event of eventStream) {
        if (event.kind === "text") {
          streamedText += event.text;
          const chunk = new ChatGenerationChunk({
            text: event.text,
            message: new AIMessageChunk({ content: event.text }),
          });
          yield chunk;
          await runManager?.handleLLMNewToken(event.text);
        } else {
          if (!options.codexStructuredOutput)
            validateCompletion(event.response, registry.tools, streamedText);
          const message = outputMessage(
            event.response,
            registry,
            session,
            model,
            options.codexStructuredOutput === true,
          );
          if (this.#config.replay) {
            const metadata = message.additional_kwargs
              .codex_response as import("./core/codec.js").ReplayMetadata;
            // Native V3 memory saves only the most recent tool batch. Keep its complete provider prefix self-contained.
            const currentUser = request.input.findLastIndex(
              (item) => item.type === "message" && item.role === "user",
            );
            metadata.prefix = request.input
              .slice(currentUser + 1)
              .filter(
                (item) =>
                  [
                    "reasoning",
                    "function_call",
                    "function_call_output",
                  ].includes(String(item.type)) ||
                  (item.type === "message" &&
                    item.role === "assistant" &&
                    item.id),
              );
            this.#config.replay.remember(metadata);
          }
          const finalText =
            typeof message.content === "string" ? message.content : "";
          // Completed output is authoritative. A partial stream must never masquerade as success.
          assert(
            !streamedText || finalText === streamedText,
            "The completed response text differs from its streaming deltas.",
          );
          recorder.complete(normalizeUsage(event.response.usage));
          const tail = streamedText ? "" : finalText;
          const chunk = new ChatGenerationChunk({
            text: tail,
            message: new AIMessageChunk({
              id: message.id,
              content: tail,
              additional_kwargs: message.additional_kwargs,
              response_metadata: message.response_metadata,
              usage_metadata: message.usage_metadata,
              invalid_tool_calls: message.invalid_tool_calls,
              // Ordinary tools require complete valid JSON; structured failures remain diagnostics.
              tool_call_chunks: [
                ...(message.tool_calls ?? []).map((call) => ({
                  id: call.id,
                  name: call.name,
                  args: JSON.stringify(call.args),
                })),
                ...(message.invalid_tool_calls ?? []).map((call) => ({
                  id: call.id,
                  name: call.name,
                  args: call.args,
                })),
              ].map((call, index) => ({
                ...call,
                index,
                type: "tool_call_chunk" as const,
              })),
            }),
            generationInfo: {
              ...(message.usage_metadata
                ? {
                    tokenUsage: {
                      promptTokens: message.usage_metadata.input_tokens,
                      completionTokens: message.usage_metadata.output_tokens,
                      totalTokens: message.usage_metadata.total_tokens,
                    },
                  }
                : {}),
              usage: message.response_metadata.usage,
              requestId: event.requestId,
              totalMs: performance.now() - started,
              transportMs: event.elapsedMs,
              firstTextMs: event.firstTextMs,
            },
          });
          yield chunk;
          if (tail) await runManager?.handleLLMNewToken(tail);
        }
      }
    } catch (error) {
      recorder?.failed();
      if (scope.signal.aborted) throw scope.error();
      throw error;
    } finally {
      recorder?.failed();
      if (!this.#config.recorder) recorder?.close();
      scope.abort();
      scope.close();
    }
  }
}
