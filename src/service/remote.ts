import { randomUUID, createHash } from "node:crypto";
import { readPrivateFile } from "../auth/store.js";
import { CodexError } from "../core/errors.js";
import { sseEvents } from "../core/sse.js";
import type { CodexService, NativeGeneration, RpcEnvelope } from "./contracts.js";
import type { Binding, ModelInfo } from "../core/types.js";
import type { AccountSnapshot } from "../account/types.js";
import type { ExecutionContext } from "../core/affinity.js";
import type { TransportEvent } from "../core/transport.js";
import { AdmissionRejection } from "../core/transport.js";

export class RemoteService implements CodexService {
  private token?: Promise<string>;
  private handshake?: Promise<void>;
  private readonly snapshots = new Map<
    string,
    {
      models?: { until: number; values: ModelInfo[] };
      limits?: { until: number; value: AccountSnapshot };
    }
  >();
  private snapshotKey(binding: Binding) {
    return createHash("sha256")
      .update(binding.profileId)
      .update("\0")
      .update(binding.bindingSecret)
      .digest("hex");
  }
  private snapshot(binding: Binding) {
    const key = this.snapshotKey(binding);
    let value = this.snapshots.get(key);
    if (!value) {
      if (this.snapshots.size >= 128) this.snapshots.delete(this.snapshots.keys().next().value!);
      value = {};
      this.snapshots.set(key, value);
    }
    return value;
  }
  cachedModels(binding: Binding): ModelInfo[] {
    const cached = this.snapshots.get(this.snapshotKey(binding))?.models;
    return cached && cached.until > Date.now() ? structuredClone(cached.values) : [];
  }
  cachedLimits(binding: Binding): AccountSnapshot | undefined {
    const cached = this.snapshots.get(this.snapshotKey(binding))?.limits;
    return cached && cached.until > Date.now() ? structuredClone(cached.value) : undefined;
  }
  constructor(
    readonly origin: string,
    readonly tokenFile: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const url = new URL(origin);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && process.env.N8N_CODEX_GATEWAY_PRIVATE_HTTP === "true"))
    )
      throw new CodexError(
        "configuration",
        "Use an HTTPS gateway origin, or explicitly enable private container HTTP.",
      );
  }
  private key() {
    return (this.token ??= readPrivateFile(this.tokenFile, 1024).then((v) => v.trim()));
  }
  private async ready() {
    this.handshake ??= (async () => {
      const response = await this.fetchImpl(new URL("/wire/v1/handshake", this.origin), {
        headers: { Authorization: `Bearer ${await this.key()}` },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      const value = (await response.json()) as {
        protocolVersion?: number;
        release?: string;
        schemaVersion?: number;
      };
      if (
        !response.ok ||
        value.protocolVersion !== 1 ||
        value.release !== "0.1.0" ||
        value.schemaVersion !== 1
      )
        throw new CodexError(
          "configuration",
          "Gateway and community package versions are incompatible. Install the matched 0.1.0 pair.",
        );
    })();
    try {
      await this.handshake;
    } catch (e) {
      this.handshake = undefined;
      throw e;
    }
  }
  private async response(
    method: RpcEnvelope["method"],
    binding: Binding | undefined,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    execution?: ExecutionContext,
    stream = false,
  ) {
    await this.ready();
    const envelope: RpcEnvelope = {
      protocolVersion: 1,
      operationId: randomUUID(),
      operationIssuedAt: Date.now(),
      execution,
      binding,
      method,
      params,
    };
    const response = await this.fetchImpl(new URL("/wire/v1/rpc", this.origin), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.key()}`,
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(envelope),
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      const value = (await response.json()) as { error?: { message?: string; code?: string } };
      if (value.error?.code === "quota_rejected") throw new AdmissionRejection(429);
      throw new CodexError(
        "provider",
        value.error?.message ?? "The gateway request failed.",
        response.status,
      );
    }
    return response;
  }
  private async call<T>(
    method: RpcEnvelope["method"],
    binding: Binding | undefined,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    execution?: ExecutionContext,
  ): Promise<T> {
    return (await this.response(method, binding, params, signal, execution)).json() as Promise<T>;
  }
  status(binding: Binding) {
    return this.call<Awaited<ReturnType<CodexService["status"]>>>("status", binding, {});
  }
  async models(binding: Binding, signal?: AbortSignal, force = false) {
    const models = await this.call<Awaited<ReturnType<CodexService["models"]>>>(
      "models",
      binding,
      { force },
      signal,
    );
    this.snapshot(binding).models = { until: Date.now() + 300000, values: structuredClone(models) };
    return models;
  }
  resolve(binding: Binding, model: string, signal?: AbortSignal) {
    return this.call<Awaited<ReturnType<CodexService["resolve"]>>>(
      "resolve",
      binding,
      { model },
      signal,
    );
  }
  usage(binding: Binding, context: ExecutionContext) {
    return this.call<Awaited<ReturnType<CodexService["usage"]>>>(
      "usage",
      binding,
      {},
      undefined,
      context,
    );
  }
  async limits(binding: Binding, options: Parameters<CodexService["limits"]>[1]) {
    const { signal, ...params } = options ?? {};
    const result = await this.call<Awaited<ReturnType<CodexService["limits"]>>>(
      "limits",
      binding,
      params,
      signal,
    );
    this.snapshot(binding).limits = { until: Date.now() + 30000, value: structuredClone(result) };
    return result;
  }
  reset(
    binding: Binding,
    options: Parameters<CodexService["reset"]>[1],
    context?: ExecutionContext,
  ) {
    this.snapshots.delete(this.snapshotKey(binding));
    const { signal, ...params } = options;
    return this.call<Awaited<ReturnType<CodexService["reset"]>>>(
      "reset",
      binding,
      params,
      signal,
      context,
    );
  }
  reconcile(
    binding: Binding,
    options: Parameters<CodexService["reconcile"]>[1],
    context?: ExecutionContext,
  ) {
    this.snapshots.delete(this.snapshotKey(binding));
    const { signal, ...params } = options;
    return this.call<Awaited<ReturnType<CodexService["reconcile"]>>>(
      "reconcile",
      binding,
      params,
      signal,
      context,
    );
  }
  async image(
    binding: Binding,
    prompt: string,
    transparent: boolean,
    options: Parameters<CodexService["image"]>[3],
  ) {
    const { signal, context, ...rest } = options ?? {};
    const result = await this.call<{
      bytes: string;
      filename: string;
      metadata: Awaited<ReturnType<CodexService["image"]>>["metadata"];
    }>("image", binding, { prompt, transparent, ...rest }, signal, context);
    return { ...result, bytes: Buffer.from(result.bytes, "base64") };
  }
  async *generate(
    binding: Binding,
    input: NativeGeneration,
    signal?: AbortSignal,
    onAdmission?: () => void | Promise<void>,
  ): AsyncGenerator<TransportEvent> {
    const response = await this.response(
      "generate",
      binding,
      input as unknown as Record<string, unknown>,
      signal,
      input.context,
      true,
    );
    if (!response.body) throw new CodexError("protocol", "The gateway returned no stream.");
    let completed = false;
    for await (const event of sseEvents(
      response.body,
      signal ?? new AbortController().signal,
      input.settings.idleTimeoutMs,
    )) {
      if (event.type === "wire.admitted") {
        await onAdmission?.();
        continue;
      }
      if (event.type === "wire.error") {
        if (event.code === "quota_rejected" && event.accepted === false)
          throw new AdmissionRejection(429);
        throw new CodexError(
          "provider",
          typeof event.message === "string"
            ? event.message
            : "The gateway generation did not finish safely.",
        );
      }
      if (event.type === "wire.event") {
        const value = event.event as TransportEvent;
        if (value.kind === "completed") completed = true;
        yield value;
      }
    }
    if (!completed)
      throw new CodexError(
        "protocol",
        "The gateway stream ended before its validated terminal result.",
      );
  }
  async finish(context: ExecutionContext) {
    await this.call("finish", undefined, {}, undefined, context);
  }
}
