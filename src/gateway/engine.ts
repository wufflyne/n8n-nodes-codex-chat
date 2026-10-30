import { randomUUID } from "node:crypto";
import type { runtimeFromEnvironment } from "../runtime.js";
import { verifiedAccess } from "../service/access.js";
import { canonicalRequest } from "../kernel/request.js";
import { validateCompletion } from "../kernel/completion.js";
import { AdmissionRejection } from "../core/transport.js";
import { CodexError } from "../core/errors.js";
import { accountIdentityKey } from "../core/affinity.js";
import { validateSettings } from "../core/catalog.js";
import type { ModelInfo, CompletedResponse } from "../core/types.js";
import { parseResponses, ItemResolver } from "./responses.js";
import { OperationStore } from "./state/operations.js";
import type { StateRepository, Stored } from "./state/repository.js";
import { type ModelRequestContext, validateContext } from "./context.js";
import type { ConnectionPolicy } from "./auth.js";
import { terminal, WireError } from "./errors.js";
import type { MemoryLease } from "./pool/memory.js";
import type { PublicResponseStream } from "./stream.js";
import { validator, withSchemaScope } from "../kernel/structured.js";
import { outputText } from "../kernel/completion.js";
import { normalizeUsage } from "../core/usage.js";
import { AdmissionQueue } from "./pool/admission.js";
import { gatewayTuning } from "./config.js";
import { historyCodec, type HistoryScope } from "./state/history-scope.js";

interface Pin {
  profile: string;
  affinity: string;
  admitted: boolean;
}
export class GatewayEngine {
  readonly resolver: ItemResolver;
  readonly operations: OperationStore;
  readonly queue: AdmissionQueue;
  constructor(
    readonly resources: ReturnType<typeof runtimeFromEnvironment>,
    readonly state: StateRepository,
    readonly contextQualified = false,
    readonly tuning = gatewayTuning(),
  ) {
    this.queue = new AdmissionQueue(tuning.admission);
    this.resolver = new ItemResolver(state, undefined, tuning.retention);
    this.operations = new OperationStore(state);
  }
  async models(policy: ConnectionPolicy, signal?: AbortSignal) {
    const models = new Map<string, ModelInfo>();
    for (const profile of policy.profiles) {
      const access = verifiedAccess(profile, "inference"),
        session = await this.resources.sessions.session(access, signal);
      for (const model of await this.resources.catalog.list(session, signal))
        if (
          this.compatible(model) &&
          (!policy.allowedModels.length ||
            policy.allowedModels.includes(model.slug))
        )
          models.set(model.slug, model);
    }
    return {
      object: "list",
      data: [...models.values()].map((m) => ({
        id: m.slug,
        object: "model",
        created: 0,
        owned_by: "codex-wire",
        name: m.name,
      })),
    };
  }
  private compatible(model: ModelInfo) {
    return (
      model.evidence === "account-catalog" &&
      !/^gpt-image(?:-|$)/.test(model.slug) &&
      (!model.inputModalities?.length || model.inputModalities.includes("text"))
    );
  }
  async respond(
    policy: ConnectionPolicy,
    raw: unknown,
    context?: ModelRequestContext,
    signal?: AbortSignal,
    stream?: PublicResponseStream,
    memory?: MemoryLease,
  ) {
    return withSchemaScope(
      !!raw &&
        typeof raw === "object" &&
        (raw as Record<string, unknown>).store === false,
      async () => {
        const parsed = parseResponses(raw);
        if (
          policy.allowedModels.length &&
          !policy.allowedModels.includes(parsed.model)
        )
          throw new WireError(
            403,
            "model_not_allowed",
            "This connection does not allow the selected model.",
            "model",
          );
        if (context) validateContext(context);
        await this.state.connectionCapacity(policy.id);
        if (
          policy.mode === "pool" &&
          (!this.contextQualified ||
            !context ||
            !policy.contextQualified ||
            policy.installationId !== context.installationId)
        )
          terminal(
            "context_required",
            "This pool requires the qualified Model Request Context v1 integration.",
          );
        const branch = context
          ? this.state.scope(
              context.installationId,
              context.projectId,
              context.conversationId,
              context.branchId,
              ...(context.kind === "turn" ? [] : [context.kind, context.runId]),
            )
          : null;
        const owner = this.state.scope("pins", policy.id),
          id = branch ?? "";
        let pin: Stored<Pin> | null = branch
          ? await this.state.get<Pin>(owner, id)
          : null;
        const candidates = pin ? [pin.value.profile] : policy.profiles;
        // Editing the candidate pool changes only new branches. Existing pins retain their owner.
        let handle: Awaited<ReturnType<OperationStore["begin"]>> | undefined;
        const reservationOwner = this.resolver.scope(policy.id),
          reservationId = randomUUID();
        let reserved = false,
          dispatched = false,
          releaseHistory: (() => void) | undefined;
        let capabilityError: unknown;
        let quotaDenied = false;
        const attemptedAccounts = new Set<string>();
        let providerOutcome:
          | "not_dispatched"
          | "unknown"
          | "admitted"
          | "rejected" = "not_dispatched";
        const safeFailure = (error: unknown) => {
          if (providerOutcome !== "unknown" && providerOutcome !== "admitted") {
            if (
              providerOutcome === "rejected" &&
              error instanceof CodexError &&
              error.category === "provider"
            )
              return new WireError(
                422,
                "provider_rejected",
                "The provider returned an HTTP error response. Provider execution and usage are not confirmed. The conversation account has not changed; inspect the error before starting a new operation.",
              );
            return error;
          }
          if (error instanceof WireError && error.status === 422) return error;
          if (
            error instanceof CodexError &&
            ["configuration", "protocol"].includes(error.category)
          )
            return new WireError(422, "invalid_completion", error.message);
          return new WireError(
            422,
            "outcome_unknown",
            "The provider request may have been admitted but local completion could not be confirmed. Recover its outcome before starting a new operation.",
          );
        };
        try {
          for (let index = 0; index < candidates.length; index++) {
            const profile = candidates[index]!,
              access = verifiedAccess(profile, "inference");
            const session = await this.resources.sessions.session(
              access,
              signal,
            );
            const catalog = await this.resources.catalog.list(session, signal),
              model = catalog.find(
                (m) => m.slug === parsed.model && this.compatible(m),
              );
            if (!model) {
              if (pin)
                throw new WireError(
                  400,
                  "model_unavailable",
                  "The exact model is unavailable for an eligible account.",
                  "model",
                );
              continue;
            }
            // Only proven local capability mismatches may omit an unpinned candidate.
            // Authentication, catalog and provider failures keep their original outcome.
            try {
              validateSettings(model, parsed.settings);
              if (
                model.useResponsesLite &&
                parsed.settings.parallelToolCalls === true
              )
                throw new WireError(
                  400,
                  "model_capability",
                  "Explicit parallel calls are unavailable on Responses Lite.",
                  "parallel_tool_calls",
                );
              for (const item of parsed.input) {
                if (!Array.isArray(item.content)) continue;
                for (const part of item.content as Array<
                  Record<string, unknown>
                >) {
                  if (part?.type !== "input_image") continue;
                  if (
                    !model.supportsImages ||
                    (part.detail === "original" && !model.originalImageDetail)
                  )
                    throw new WireError(
                      400,
                      "model_capability",
                      "The selected account and model do not support this image input.",
                      "input",
                    );
                }
              }
            } catch (error) {
              if (
                pin ||
                !(
                  error instanceof WireError ||
                  (error instanceof CodexError &&
                    error.category === "configuration")
                )
              )
                throw error;
              capabilityError = error;
              continue;
            }
            if (pin && pin.value.affinity !== session.affinity)
              terminal(
                "account_identity_changed",
                "The pinned account identity changed. Recover this conversation explicitly.",
              );
            if (!session.identity)
              terminal(
                "account_identity_required",
                "The account identity could not be verified.",
              );
            const account = accountIdentityKey(session.identity);
            if (attemptedAccounts.has(account)) continue;
            attemptedAccounts.add(account);
            const historyScope: HistoryScope = {
              account: session.affinity,
              model: model.slug,
              branch,
              codec: historyCodec(model),
            };
            releaseHistory?.();
            releaseHistory = undefined;
            const history = await this.resolver.resolveAdmitted(
              policy.id,
              historyScope,
              parsed.input,
              parsed.store,
              signal,
              memory,
            );
            releaseHistory = history.release;
            const input = history.items;
            const request = canonicalRequest({ ...parsed, input }, model);
            // All shape, history, model, capability and schema checks precede admission and reset side effects.
            if (context && !handle) {
              handle = await this.operations.begin(
                policy.id,
                context,
                raw,
                parsed.store,
                historyScope,
              );
              if (handle.replay)
                return {
                  body: handle.replay as ReturnType<
                    ItemResolver["prepare"]
                  >["body"],
                  stream: parsed.stream,
                  replayed: true,
                };
            }
            if (!reserved) {
              await this.state.reserve(
                reservationOwner,
                reservationId,
                16 * 1024 * 1024,
                Date.now() +
                  this.queue.limits.waitMs +
                  parsed.settings.timeoutMs +
                  60000,
              );
              reserved = true;
            }
            const release = await this.queue.acquire(account, branch, signal);
            try {
              const currentPolicy = await this.state.get<ConnectionPolicy>(
                this.state.scope("authorization"),
                `policy:${policy.id}`,
              );
              if (
                currentPolicy &&
                (!currentPolicy.value.enabled ||
                  (!pin && !currentPolicy.value.profiles.includes(profile)) ||
                  (currentPolicy.value.allowedModels.length &&
                    !currentPolicy.value.allowedModels.includes(model.slug)))
              )
                terminal(
                  "policy_changed",
                  "This connection changed while the request was preparing. No generation was dispatched.",
                );
              if (branch && !pin) {
                await this.state.transaction(
                  [{ owner, id, revision: null }],
                  [
                    {
                      owner,
                      id,
                      value: {
                        profile,
                        affinity: session.affinity,
                        admitted: false,
                      },
                      expires: Number.MAX_SAFE_INTEGER,
                    },
                  ],
                );
                pin = await this.state.get<Pin>(owner, id);
              }
              if (branch && pin && pin.value.profile !== profile)
                terminal(
                  "pin_conflict",
                  "The conversation account reservation changed concurrently.",
                );
              let completed: CompletedResponse | undefined,
                text = "",
                bytes = 0,
                timing: { elapsedMs: number; firstTextMs?: number } | undefined;
              dispatched = true;
              providerOutcome = "unknown";
              for await (const event of this.resources.transport.stream(
                request,
                session,
                parsed.settings,
                [signal],
                model.useResponsesLite,
                {
                  affinity: branch
                    ? this.state.scope(
                        "affinity",
                        policy.id,
                        session.affinity,
                        model.slug,
                        branch,
                      )
                    : undefined,
                  onAdmission: async () => {
                    providerOutcome = "admitted";
                    if (branch && pin && !pin.value.admitted) {
                      await this.state.transaction(
                        [{ owner, id, revision: pin.revision }],
                        [
                          {
                            owner,
                            id,
                            value: { ...pin.value, admitted: true },
                            expires: Number.MAX_SAFE_INTEGER,
                          },
                        ],
                      );
                      pin = await this.state.get<Pin>(owner, id);
                    }
                    await stream?.start();
                  },
                  onRejected: () => {
                    providerOutcome = "rejected";
                  },
                  onItem: stream
                    ? async (item, index) => stream.item(item, index)
                    : undefined,
                  streamLimits: {
                    eventBytes: 2 * 1024 * 1024,
                    streamBytes: 8 * 1024 * 1024,
                  },
                  onRejection: async () => {
                    const snapshot = await this.resources.account.readAccount(
                      access,
                      {
                        signal,
                        afterRejection: true,
                        model: model.slug,
                      },
                    );
                    return snapshot.routing.decision === "quota_exhausted"
                      ? "quota"
                      : "retry";
                  },
                },
              )) {
                if (event.kind === "text") {
                  text += event.text;
                  bytes += Buffer.byteLength(event.text);
                  if (bytes > 2 * 1024 * 1024)
                    terminal(
                      "output_limit",
                      "The admitted response exceeded the output memory limit.",
                    );
                  await stream?.text(event);
                } else {
                  completed = event.response;
                  timing = {
                    elapsedMs: event.elapsedMs,
                    firstTextMs: event.firstTextMs,
                  };
                }
              }
              if (!completed)
                terminal(
                  "outcome_unknown",
                  "The provider did not return a validated terminal response.",
                );
              if (completed.output.length > 256)
                terminal(
                  "output_limit",
                  "The admitted response exceeded the output item limit.",
                );
              validateCompletion(completed, parsed.tools, text);
              stream?.validate(completed);
              if (
                completed.output.some(
                  (item) =>
                    Array.isArray(item.content) &&
                    item.content.some(
                      (part) =>
                        (part as Record<string, unknown>).type === "refusal",
                    ),
                )
              )
                terminal(
                  "provider_refusal",
                  "The provider declined this request. The pinned Responses SDK does not support refusal content; no tool calls were released.",
                );
              if (parsed.format) {
                let data: unknown;
                try {
                  data = JSON.parse(outputText(completed));
                } catch {
                  terminal(
                    "schema_output_invalid",
                    "The completed output is not valid JSON.",
                  );
                }
                if (!validator(parsed.format.schema)(data))
                  terminal(
                    "schema_output_invalid",
                    "The completed output does not satisfy the requested schema.",
                  );
              }
              if (
                Buffer.byteLength(JSON.stringify(completed)) >
                2 * 1024 * 1024
              )
                terminal(
                  "output_limit",
                  "The admitted response exceeded the output state limit.",
                );
              const prepared = this.resolver.prepare(
                policy.id,
                historyScope,
                completed,
                parsed.store,
                stream?.identity,
              );
              prepared.writes.push({
                owner: this.state.scope("activity"),
                id: handle?.id ?? randomUUID(),
                value: {
                  at: new Date().toISOString(),
                  connectionId: policy.id,
                  profileId: profile,
                  model: model.slug,
                  route: model.useResponsesLite
                    ? "responses-lite"
                    : "responses",
                  usage: normalizeUsage(completed.usage),
                  ...timing,
                },
                expires: Date.now() + 48 * 3600000,
              });
              if (handle)
                await this.operations.finish(
                  handle,
                  "completed",
                  { body: prepared.body, scope: historyScope },
                  prepared.writes,
                  {
                    owner: reservationOwner,
                    id: reservationId,
                  },
                );
              else
                await this.state.transaction([], prepared.writes, {
                  owner: reservationOwner,
                  id: reservationId,
                });
              reserved = false;
              return {
                body: prepared.body,
                stream: parsed.stream,
                replayed: false,
              };
            } catch (error) {
              const mayAdvance =
                error instanceof AdmissionRejection &&
                !pin?.value.admitted &&
                index + 1 < candidates.length;
              if (mayAdvance) {
                quotaDenied = true;
                if (branch && pin) {
                  await this.state.transaction(
                    [{ owner, id, revision: pin.revision }],
                    [{ owner, id, remove: true }],
                  );
                  pin = null;
                }
                dispatched = false;
                continue;
              }
              throw error;
            } finally {
              release();
            }
          }
          if (quotaDenied)
            throw new WireError(
              429,
              "accounts_exhausted",
              "No eligible account has applicable allowance for this new conversation.",
            );
          if (capabilityError) throw capabilityError;
          if (!dispatched)
            throw new WireError(
              400,
              "model_unavailable",
              "The exact model is unavailable for an eligible account.",
              "model",
            );
          throw new WireError(
            429,
            "accounts_exhausted",
            "No account has applicable allowance for this new conversation.",
          );
        } catch (error) {
          if (handle) {
            try {
              await this.operations.finish(
                handle,
                ["unknown", "admitted"].includes(providerOutcome) ||
                  (error instanceof CodexError &&
                    error.status !== undefined &&
                    error.status >= 500)
                  ? "unknown"
                  : "rejected",
              );
            } catch {
              /* The original durable intent continues to fence retries. */
            }
          }
          throw safeFailure(error);
        } finally {
          releaseHistory?.();
          if (reserved) {
            try {
              await this.state.release(reservationOwner, reservationId);
            } catch (error) {
              throw safeFailure(error);
            }
          }
        }
      },
    );
  }
}
