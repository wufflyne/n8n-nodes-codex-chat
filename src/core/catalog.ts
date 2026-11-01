import { PACKAGE_VERSION } from "../version.js";
import { CodexError, assert, record, string } from "./errors.js";
import {
  admissionError,
  readJson,
  requestScope,
  throwIfAborted,
  waitForSignal,
  type Fetch,
} from "./http.js";
import {
  CLIENT_VERSION,
  CODEX_BASE,
  type ModelInfo,
  type ModelSettings,
  type Session,
} from "./types.js";

export function accountHeaders(session: Session): Record<string, string> {
  assert(
    !/[\r\n]/.test(session.accountId),
    "The account identifier is invalid.",
  );
  return {
    Authorization: `Bearer ${session.accessToken}`,
    "ChatGPT-Account-Id": session.accountId,
    originator: "n8n_codex_chat",
    "User-Agent": `n8n-codex-chat/${PACKAGE_VERSION}`,
  };
}

/** Detach the complete validated catalog shape without serializing unrelated entries. */
function cloneModel(model: ModelInfo): ModelInfo {
  return {
    ...model,
    reasoningEfforts: [...model.reasoningEfforts],
    serviceTiers: model.serviceTiers.map((tier) => ({ ...tier })),
    ...(model.inputModalities
      ? { inputModalities: [...model.inputModalities] }
      : {}),
  };
}

export class ModelCatalog {
  private readonly cache = new Map<
    string,
    { until: number; models: ModelInfo[] }
  >();
  private readonly pending = new Map<string, Promise<ModelInfo[]>>();
  constructor(
    private readonly fetchImpl: Fetch = fetch,
    private readonly baseUrl = CODEX_BASE,
    private readonly ttlMs = 300000,
  ) {}

  async list(
    session: Session,
    signal?: AbortSignal,
    force = false,
  ): Promise<ModelInfo[]> {
    return (await this.snapshot(session, signal, force)).map(cloneModel);
  }

  cached(affinity: string, generation: number): ModelInfo[] {
    const cached = this.cache.get(`${affinity}:${generation}`);
    return (cached && cached.until > Date.now() ? cached.models : []).map(cloneModel);
  }
  async settleReads() { await Promise.allSettled([...this.pending.values()]); }

  /** Internal cache ownership never escapes; public callers receive detached models. */
  private async snapshot(
    session: Session,
    signal?: AbortSignal,
    force = false,
  ): Promise<ModelInfo[]> {
    throwIfAborted(signal);
    const key = `${session.affinity}:${session.generation}`;
    const cached = this.cache.get(key);
    if (!force && cached && cached.until > Date.now())
      return cached.models;
    let promise = this.pending.get(key);
    if (!promise) {
      promise = this.load(session);
      this.pending.set(key, promise);
      void promise
        .finally(() => this.pending.delete(key))
        .catch(() => undefined);
    }
    return waitForSignal(promise, signal);
  }

  private async load(
    session: Session,
    signal?: AbortSignal,
  ): Promise<ModelInfo[]> {
    const scope = requestScope([signal], 20000);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/models?client_version=${CLIENT_VERSION}`,
        {
          headers: accountHeaders(session),
          redirect: "error",
          signal: scope.signal,
        },
      );
      if (!response.ok) throw await admissionError(response);
      const body = record(
        await readJson(response, 4 * 1024 * 1024, scope.signal),
      );
      assert(
        Array.isArray(body.models),
        "The account catalog has an unsupported format.",
      );
      assert(
        body.models.length <= 1024,
        "The model catalog exceeds the entry limit.",
      );
      const models = body.models
        .map((value) => {
          try {
            return parseModel(value);
          } catch {
            return undefined;
          }
        })
        .filter((model): model is ModelInfo => model !== undefined);
      assert(
        models.length > 0,
        "The account catalog has no visible models. Reconnect the profile or check its subscription access.",
      );
      // Keep the cache bounded in long-lived installations.
      if (this.cache.size >= 100)
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(`${session.affinity}:${session.generation}`, {
        models,
        until: Date.now() + this.ttlMs,
      });
      return models;
    } catch (error) {
      if (scope.signal.aborted) throw scope.error();
      if (error instanceof CodexError) throw error;
      throw new CodexError(
        "provider",
        "The account model catalog could not be loaded. Check connectivity and retry.",
      );
    } finally {
      scope.close();
    }
  }

  async model(
    session: Session,
    slug: string,
    signal?: AbortSignal,
  ): Promise<ModelInfo> {
    const model = (await this.snapshot(session, signal)).find(
      (entry) => entry.slug === slug,
    );
    assert(
      model,
      "The selected model is not in this account catalog. Run Codex Account → Refresh Models and choose an advertised model or its exact ID.",
    );
    return cloneModel(model);
  }
}

export function parseModel(value: unknown): ModelInfo | undefined {
  const model = record(value);
  if (model.visibility !== "list") return undefined;
  assert(
    model.use_responses_lite === undefined ||
      typeof model.use_responses_lite === "boolean",
    "The catalog route discriminator is invalid.",
  );
  const bounded = (v: unknown, max = 200): string | undefined =>
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= max &&
    !/[\x00-\x1f\x7f]/.test(v)
      ? v
      : undefined;
  const efforts = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels.slice(0, 64).flatMap((item) => {
        const effort =
          item && typeof item === "object"
            ? bounded(item.effort, 32)
            : undefined;
        return effort ? [effort] : [];
      })
    : [];
  const tiers = Array.isArray(model.service_tiers)
    ? model.service_tiers.slice(0, 64).flatMap((item) => {
        const tier =
          item && typeof item === "object"
            ? (item as Record<string, unknown>)
            : {};
        const id = bounded(tier.id, 64);
        return id ? [{ id, name: bounded(tier.name, 100) ?? id }] : [];
      })
    : [];
  const modalities = Array.isArray(model.input_modalities)
    ? model.input_modalities
        .filter((v): v is string => bounded(v, 32) !== undefined)
        .slice(0, 32)
    : [];
  const slug = string(model.slug, "Model identifier", 200);
  assert(
    !/[\x00-\x20\x7f]/.test(slug),
    "The catalog model identity is invalid.",
  );
  return {
    slug,
    name: bounded(model.display_name) ?? slug,
    description: bounded(model.description, 1024),
    reasoningEfforts: [...new Set(efforts)],
    supportsSummary:
      model.supports_reasoning_summary_parameter === undefined ||
      model.supports_reasoning_summary_parameter === true,
    supportsVerbosity: model.support_verbosity === true,
    serviceTiers: tiers,
    supportsImages: modalities.includes("image"),
    inputModalities: modalities,
    originalImageDetail: model.supports_image_detail_original === true,
    contextWindow:
      typeof model.context_window === "number" &&
      Number.isSafeInteger(model.context_window) &&
      model.context_window > 0
        ? model.context_window
        : undefined,
    defaultReasoningEffort: bounded(model.default_reasoning_level, 32),
    defaultVerbosity: bounded(model.default_verbosity, 32),
    useResponsesLite: model.use_responses_lite === true,
    evidence: "account-catalog",
  };
}

export function validateSettings(
  model: ModelInfo,
  settings: ModelSettings,
): void {
  validateReliability(settings);
  if (settings.reasoningEffort)
    assert(
      model.reasoningEfforts.includes(settings.reasoningEffort),
      "The selected reasoning effort is not advertised for this model. Choose Model Default.",
    );
  if (settings.reasoningSummary)
    assert(
      model.supportsSummary &&
        ["auto", "concise", "detailed"].includes(settings.reasoningSummary),
      "Reasoning summaries are not advertised for this model. Choose Model Default.",
    );
  if (settings.verbosity)
    assert(
      model.supportsVerbosity &&
        ["low", "medium", "high"].includes(settings.verbosity),
      "Verbosity control is not advertised for this model. Choose Model Default.",
    );
  if (settings.serviceTier)
    assert(
      model.serviceTiers.some((tier) => tier.id === settings.serviceTier),
      "The selected speed tier is not advertised for this account and model. Choose Account Default.",
    );
}

export function validateReliability(settings: ModelSettings): void {
  assert(
    settings.parallelToolCalls === undefined ||
      typeof settings.parallelToolCalls === "boolean",
    "Parallel tool calls must be a boolean.",
  );
  assert(
    Number.isFinite(settings.timeoutMs) &&
      settings.timeoutMs >= 1000 &&
      settings.timeoutMs <= 3600000,
    "Overall timeout must be between 1 and 3600 seconds.",
  );
  assert(
    Number.isFinite(settings.idleTimeoutMs) &&
      settings.idleTimeoutMs >= 1000 &&
      settings.idleTimeoutMs <= settings.timeoutMs,
    "Stream idle timeout must be at least one second and no longer than the overall timeout.",
  );
  assert(
    Number.isInteger(settings.maxRetries) &&
      settings.maxRetries >= 0 &&
      settings.maxRetries <= 5,
    "Admission retries must be between 0 and 5.",
  );
}
