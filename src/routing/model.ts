import {
  AIMessageChunk,
  type AIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  BaseChatModel,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import type {
  BaseLanguageModelInput,
  StructuredOutputMethodOptions,
} from "@langchain/core/language_models/base";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { Runnable } from "@langchain/core/runnables";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { CodexCallOptions } from "../model.js";
import { assert, CodexError, AccountsExhaustedError } from "../core/errors.js";
import { requestScope } from "../core/http.js";
import { recordInvocation } from "../core/execution-usage.js";
import { approximateTextTokens } from "../core/token-estimate.js";
import { structuredRunnable } from "../core/structured.js";
import { boundToolsSnapshot, toolRegistry } from "../core/codec.js";
import type { ExecutionContext, AffinityPolicy } from "../core/affinity.js";
import { AdmissionRejection } from "../core/transport.js";
import { lowAllowance, validateRecovery } from "../account/reset-policy.js";
import {
  DEFAULT_RECOVERY,
  type RecoveryPolicy,
  type AccountSnapshot,
} from "../account/types.js";
import { CODEX_CANDIDATE, type CodexCandidate } from "./candidate.js";
import {
  enter,
  completeTurn,
  fingerprint,
  type RouterCoordinator,
} from "./coordinator.js";
export interface RouterOptions {
  candidates: unknown[];
  coordinator: RouterCoordinator;
  context: ExecutionContext;
  unknownLimits: "try" | "stop";
  policy?: RecoveryPolicy;
  affinityPolicy?: AffinityPolicy;
  signal?: AbortSignal;
  onSummary?: (summary: {
    state: string;
    selectedAlias: string | null;
    accounts: Array<{
      alias: string;
      decision: string;
      earliestResetAt: string | null;
    }>;
  }) => void;
}
export class CodexAccountRouterModel extends BaseChatModel<CodexCallOptions> {
  lc_serializable = false;
  #options: RouterOptions;
  #candidates: CodexCandidate[];
  constructor(options: RouterOptions) {
    super({ maxRetries: 0 });
    assert(
      options.candidates.length >= 2 && options.candidates.length <= 5,
      "Connect two to five Codex Chat Models.",
    );
    this.#options = {
      ...options,
      policy: { ...DEFAULT_RECOVERY, ...options.policy },
    };
    validateRecovery(this.#options.policy!);
    this.#candidates = options.candidates.map((candidate) => {
      assert(
        candidate !== null &&
          typeof candidate === "object" &&
          typeof (candidate as Record<symbol, unknown>)[CODEX_CANDIDATE] ===
            "function",
        "Connect Codex Chat Models directly; nested routers and other providers are unsupported.",
      );
      const result = (candidate as Record<symbol, () => CodexCandidate>)[
        CODEX_CANDIDATE
      ]!();
      assert(
        !result.autoReset,
        "Turn off automatic resets on router leaf models; the router owns Account Recovery.",
      );
      return result;
    });
    const reference = this.#candidates[0]!;
    assert(
      this.#candidates.every(
        (c) =>
          c.model === reference.model &&
          fingerprint(this.semantic(c)) ===
            fingerprint(this.semantic(reference)),
      ),
      "Router candidates must use the same model and explicit semantic settings.",
    );
  }
  _llmType() {
    return "codex-account-router";
  }
  _identifyingParams() {
    return {
      provider: this._llmType(),
      model: this.#candidates[0]!.model,
      accounts: this.#candidates.length,
    };
  }
  async getNumTokens(content: BaseMessage["content"]) {
    return approximateTextTokens(content);
  }
  bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<CodexCallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, CodexCallOptions> {
    return this.withConfig({
      ...kwargs,
      tools: boundToolsSnapshot(tools),
    });
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
    assert(combined, "The router returned no completed generation.");
    return {
      generations: [{ text: combined.text, message: combined.message }],
      llmOutput: combined.generationInfo,
    };
  }
  private semantic(c: CodexCandidate) {
    const s = c.settings;
    return [
      c.model,
      s.reasoningEffort ?? "",
      s.reasoningSummary ?? "",
      s.verbosity ?? "",
      s.serviceTier ?? "",
      s.parallelToolCalls ?? true,
    ];
  }
  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const config = this.#options,
      state = config.coordinator,
      policy = config.policy!,
      settings = this.#candidates[0]!.settings;
    const signature = fingerprint([
      this.#candidates.map((c) => [c.key, this.semantic(c)]),
      policy,
      options.parallel_tool_calls,
      toolRegistry(options.tools).tools,
      options.codexOutputFormat,
    ]);
    enter(state, messages, signature);
    let summaryDone = false;
    const summary = (
      snapshots?: Map<number, AccountSnapshot>,
      final = false,
    ) => {
      if (summaryDone) return;
      if (final) summaryDone = true;
      try {
        config.onSummary?.({
          state: state.state,
          selectedAlias:
            state.pinned === undefined ? null : `Account ${state.pinned + 1}`,
          accounts: this.#candidates.map((_, i) => ({
            alias: `Account ${i + 1}`,
            decision: snapshots?.get(i)?.routing.decision ?? "unknown",
            earliestResetAt: snapshots?.get(i)?.routing.earliestResetAt ?? null,
          })),
        });
      } catch {
        /* Reporting does not alter admission policy. */
      }
    };
    summary();
    const scope = requestScope(
        [options.signal, options.abortSignal, config.signal],
        settings.timeoutMs,
      ),
      deadline = Date.now() + settings.timeoutMs;
    try {
      const resolved = await Promise.all(
        this.#candidates.map((c) => c.resolve(scope.signal)),
      );
      const identities = resolved.map((r) => {
        assert(
          r.session.identity,
          "Router candidates require a verified native account identity.",
        );
        const i = r.session.identity;
        return JSON.stringify([i.issuer, i.clientId, i.accountId]);
      });
      assert(
        new Set(identities).size === identities.length,
        "Router candidates must represent distinct verified provider accounts.",
      );
      const descriptors = fingerprint(
        resolved.map((r) => [r.session.affinity, r.model]),
      );
      assert(
        !state.descriptorSignature || state.descriptorSignature === descriptors,
        "A router account identity or catalog capability changed during this invocation.",
      );
      state.descriptorSignature = descriptors;
      for (const field of [
        "defaultReasoningEffort",
        "defaultVerbosity",
      ] as const) {
        const explicit =
          field === "defaultReasoningEffort"
            ? settings.reasoningEffort
            : settings.verbosity;
        const known = resolved
          .map((r) => r.model[field])
          .filter((v): v is string => v !== undefined);
        if (!explicit)
          assert(
            new Set(known).size <= 1,
            "Account catalogs advertise different defaults. Choose a common explicit setting before routing.",
          );
      }
      if (state.pinned !== undefined)
        assert(
          resolved[state.pinned]!.session.affinity === state.affinity,
          "The pinned account identity changed during this invocation.",
        );
      const snapshots = new Map<number, AccountSnapshot>(),
        deferred: number[] = [],
        rejected = new Set<number>();
      let resetDispatched = false;
      const passes =
        state.pinned !== undefined
          ? [[state.pinned]]
          : [this.#candidates.map((_, i) => i), deferred];
      let finished = false;
      for (let pass = 0; pass < passes.length && !finished; pass++)
        for (const index of passes[pass]!) {
          const candidate = this.#candidates[index]!,
            selected = resolved[index]!;
          let snapshot = await candidate.read(scope.signal, false);
          snapshots.set(index, snapshot);
          const low = lowAllowance(snapshot, policy),
            exhausted = snapshot.routing.decision === "quota_exhausted",
            pinned = state.pinned !== undefined;
          if (
            !pinned &&
            pass === 0 &&
            policy.automatic &&
            policy.order === "next-first" &&
            (low || exhausted)
          ) {
            deferred.push(index);
            continue;
          }
          let recovered = false;
          if (
            policy.automatic &&
            (low || exhausted) &&
            !resetDispatched &&
            (pinned || policy.order === "reset-first" || pass === 1)
          ) {
            candidate.validateInput(messages, options, selected, {
              replay: state.replay,
              context: config.context,
              affinityPolicy: config.affinityPolicy,
            });
            const reset = await candidate.recover(policy, scope.signal);
            resetDispatched =
              reset.action.state === "terminal" ||
              reset.action.state === "uncertain";
            assert(
              reset.action.state !== "uncertain",
              "The reset outcome is unknown. No other reset will be used for this account until the pending action is resolved.",
            );
            snapshot = await candidate.read(scope.signal, true);
            snapshots.set(index, snapshot);
            recovered =
              reset.action.outcome === "reset" &&
              snapshot.routing.decision === "allowed";
          }
          if (snapshot.routing.decision === "quota_exhausted") {
            if (pinned)
              throw new CodexError(
                "rate_limit",
                "This account cannot continue the current tool turn. Start a new execution to use another account.",
              );
            continue;
          }
          if (
            snapshot.routing.decision === "unknown" &&
            config.unknownLimits === "stop"
          )
            throw new CodexError(
              "rate_limit",
              "Account limits are unknown. Check account limits before routing.",
            );
          if (rejected.has(index) && !recovered) continue;
          let postReset = false;
          const recorder = recordInvocation(
            config.context,
            selected.session.affinity,
            selected.model.slug,
            selected.model.useResponsesLite ? "responses-lite" : "responses",
          );
          try {
            while (true) {
              let combined: AIMessageChunk | undefined;
              const clone = candidate.clone({
                replay: state.replay,
                context: config.context,
                affinityPolicy: config.affinityPolicy,
                executionSignal: scope.signal,
                account: undefined,
                recorder,
                transportContext: {
                  deadline,
                  onAdmission: () => {
                    state.state = "pinned";
                    state.pinned = index;
                    state.affinity = selected.session.affinity;
                  },
                  onRejection: async (_r, signal) => {
                    snapshot = await candidate.readAfterRejection(signal);
                    snapshots.set(index, snapshot);
                    return snapshot.routing.decision === "quota_exhausted"
                      ? "quota"
                      : "retry";
                  },
                },
              });
              try {
                const stream = await clone.stream(messages, {
                  ...options,
                  signal: scope.signal,
                  callbacks: undefined,
                  runName: `Account ${index + 1}`,
                });
                for await (const message of stream) {
                  combined = combined ? combined.concat(message) : message;
                  yield new ChatGenerationChunk({
                    text:
                      typeof message.content === "string"
                        ? message.content
                        : "",
                    message,
                  });
                  if (typeof message.content === "string" && message.content)
                    await runManager?.handleLLMNewToken(message.content);
                }
                assert(
                  combined,
                  "The selected account returned no completed generation.",
                );
                completeTurn(state, combined as unknown as AIMessage);
                summary(snapshots, true);
                finished = true;
                break;
              } catch (error) {
                if (!(error instanceof AdmissionRejection)) throw error;
                rejected.add(index);
                if (state.pinned !== undefined) {
                  if (policy.automatic && !postReset && !resetDispatched) {
                    postReset = true;
                    const reset = await candidate.recover(policy, scope.signal);
                    resetDispatched =
                      reset.action.state === "terminal" ||
                      reset.action.state === "uncertain";
                    assert(
                      reset.action.state !== "uncertain",
                      "The reset outcome is unknown. No other reset will be used for this account until the pending action is resolved.",
                    );
                    if (reset.action.recovery === "allowed") {
                      recorder.postReset();
                      continue;
                    }
                  }
                  throw new CodexError(
                    "rate_limit",
                    "This account cannot continue the current tool turn. Start a new execution to use another account.",
                  );
                }
                if (
                  policy.automatic &&
                  policy.order === "reset-first" &&
                  !postReset &&
                  !resetDispatched
                ) {
                  postReset = true;
                  const reset = await candidate.recover(policy, scope.signal);
                  resetDispatched =
                    reset.action.state === "terminal" ||
                    reset.action.state === "uncertain";
                  assert(
                    reset.action.state !== "uncertain",
                    "The reset outcome is unknown. No other reset will be used for this account until the pending action is resolved.",
                  );
                  if (reset.action.recovery === "allowed") {
                    recorder.postReset();
                    continue;
                  }
                }
                if (
                  policy.automatic &&
                  policy.order === "next-first" &&
                  pass === 0 &&
                  !deferred.includes(index)
                )
                  deferred.push(index);
                break;
              }
            }
          } finally {
            recorder.failed();
            recorder.close();
          }
          if (finished) break;
        }
      if (!finished) {
        state.state = "failed";
        summary(snapshots, true);
        throw new AccountsExhaustedError(
          this.#candidates.map((_, i) => ({
            alias: `Account ${i + 1}`,
            decision: snapshots.get(i)?.routing.decision ?? "unknown",
            earliestResetAt: snapshots.get(i)?.routing.earliestResetAt ?? null,
          })),
        );
      }
    } catch (error) {
      state.state = "failed";
      summary(undefined, true);
      if (scope.signal.aborted) throw scope.error();
      throw error;
    } finally {
      state.inFlight = false;
      scope.abort();
      scope.close();
    }
  }
}
