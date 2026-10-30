import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, createHash, createHmac } from "node:crypto";
import path from "node:path";
import { readPrivateFile, atomicWrite } from "../auth/store.js";
import { mkdir, lstat, realpath, readdir, unlink } from "node:fs/promises";
import { attestContext, validateContext, type ModelRequestContext } from "../gateway/context.js";

export const CONTEXT_HOOK_SYMBOL = Symbol.for("n8n.model-request-context.v1");
export interface ServerRunIdentity {
  projectId: string;
  agentRevision: string;
  conversationId: string;
  branchId: string;
  turnId: string;
  hostRunId: string;
  hostIssuedAt?: number;
  parentOperationId?: string;
  kind?: ModelRequestContext["kind"];
}
export interface ContextHooks {
  prepare(
    input: {
      runId: string;
      agentRevision?: string;
      parentOperationId?: string;
      previous?: ModelRequestContext;
      cause?: ModelRequestContext["cause"];
      kind?: ModelRequestContext["kind"];
    },
    persist: (context: ModelRequestContext) => Promise<void>,
  ): Promise<ModelRequestContext | undefined>;
  run<T>(context: ModelRequestContext | undefined, action: () => T): T;
  decorateModel<T>(model: T, kind?: ModelRequestContext["kind"]): T;
  decorateFetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch;
}
interface RunScope {
  identity: ServerRunIdentity;
  rootRunId?: string;
  parentOperationId?: string;
  helperCounts: Map<string, number>;
}
interface IntegrationConfig {
  version: 1;
  installationId: string;
  installationKeyFile: string;
  journalDirectory: string;
  gatewayOrigins: string[];
}
const runs = new AsyncLocalStorage<RunScope>(),
  operations = new AsyncLocalStorage<ModelRequestContext>();
let installed: ContextHooks | undefined;
let configuration: Promise<{ config: IntegrationConfig; key: string }> | undefined;
const knownOperations = new Map<string, ModelRequestContext>();
const JOURNAL_BYTES = 64 * 1024 * 1024,
  JOURNAL_FILES = 65536;
let journalBytes = 0,
  journalFiles = 0,
  journalScannedAt = 0;
let journalTail: Promise<void> = Promise.resolve();
function remember(context: ModelRequestContext) {
  knownOperations.delete(context.operationId);
  knownOperations.set(context.operationId, context);
  while (knownOperations.size > 4096) knownOperations.delete(knownOperations.keys().next().value!);
}
async function scanJournal(directory: string) {
  const cutoff = Date.now() - 48 * 3600000;
  let bytes = 0,
    count = 0;
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new Error("Unexpected context journal entry.");
    const filename = path.join(directory, name),
      stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 8192)
      throw new Error("Context journal entries must be bounded private regular files.");
    if (stat.mtimeMs < cutoff) {
      const record = JSON.parse(await readPrivateFile(filename, 8192)) as ModelRequestContext;
      if (Number.isSafeInteger(record.operationIssuedAt) && record.operationIssuedAt < cutoff) {
        await unlink(filename);
        continue;
      }
    }
    bytes += stat.size;
    count++;
    if (bytes > JOURNAL_BYTES || count > JOURNAL_FILES)
      throw new Error("Context journal capacity is exhausted.");
  }
  journalBytes = bytes;
  journalFiles = count;
  journalScannedAt = Date.now();
}
async function persistJournal(directory: string, context: ModelRequestContext) {
  const action = journalTail.then(async () => {
    if (Date.now() - journalScannedAt > 3600000) await scanJournal(directory);
    const content = JSON.stringify(context),
      bytes = Buffer.byteLength(content);
    if (bytes > 8192 || journalBytes + bytes > JOURNAL_BYTES || journalFiles >= JOURNAL_FILES)
      throw new Error("Context journal capacity is exhausted.");
    await atomicWrite(path.join(directory, `${context.operationId}.json`), content);
    journalBytes += bytes;
    journalFiles++;
  });
  journalTail = action.catch(() => undefined);
  return action;
}
const agentRevisions = new WeakMap<object, string>();
const handshakes = new Map<string, Promise<{ id: string; expires: number }>>();
export function registerAgentRevision(agent: object, revision: unknown) {
  const id = revisionIdentity(revision);
  agentRevisions.set(agent, id);
  const setter = (agent as { setModelRequestRevision?: (id: string) => unknown })
    .setModelRequestRevision;
  if (typeof setter !== "function")
    throw new Error("The installed Agent SDK lacks the matched revision hook.");
  setter.call(agent, id);
}
export function agentRevision(agent: object) {
  const revision = agentRevisions.get(agent);
  if (!revision) throw new Error("The host did not register the Agent revision.");
  return revision;
}

/** Capture before dispatch so a later parent turn cannot relink an asynchronous child. */
export function currentParentOperationId(): string | undefined {
  return operations.getStore()?.operationId ?? runs.getStore()?.parentOperationId;
}

/** Called by the matched n8n server only, from accepted server execution state. */
export async function withServerRun<T>(
  identity: ServerRunIdentity,
  action: () => T,
): Promise<Awaited<T>> {
  if (!process.env.N8N_CODEX_CONTEXT_CONFIG_FILE) return await action();
  await installFromEnvironment();
  return await runs.run(
    {
      identity: Object.freeze({ ...identity }),
      helperCounts: new Map(),
      parentOperationId: identity.parentOperationId ?? currentParentOperationId(),
    },
    action,
  );
}
async function settings() {
  configuration ??= (async () => {
    const filename = process.env.N8N_CODEX_CONTEXT_CONFIG_FILE;
    if (!filename) throw new Error("Model Request Context configuration is missing.");
    const config = JSON.parse(await readPrivateFile(filename, 16384)) as IntegrationConfig;
    if (
      config.version !== 1 ||
      !config.installationId ||
      !path.isAbsolute(config.journalDirectory) ||
      !Array.isArray(config.gatewayOrigins) ||
      !config.gatewayOrigins.length
    )
      throw new Error("Invalid Model Request Context configuration.");
    for (const origin of config.gatewayOrigins) {
      const url = new URL(origin);
      if (url.origin !== origin || !["http:", "https:"].includes(url.protocol))
        throw new Error("Use exact gateway origins in the context allowlist.");
    }
    const key = (await readPrivateFile(config.installationKeyFile, 1024)).trim();
    await mkdir(config.journalDirectory, { recursive: true, mode: 0o700 });
    const stat = await lstat(config.journalDirectory);
    if (
      stat.mode & 0o077 ||
      (await realpath(config.journalDirectory)) !== path.resolve(config.journalDirectory)
    )
      throw new Error("Context journal must be a private real directory.");
    await scanJournal(config.journalDirectory);
    return { config, key };
  })();
  return configuration;
}

export async function installFromEnvironment(): Promise<ContextHooks> {
  if (installed) return installed;
  const { config, key } = await settings();
  async function allocate(
    runId: string,
    kind: ModelRequestContext["kind"],
    previous?: ModelRequestContext,
    cause: ModelRequestContext["cause"] = "generation",
    persist?: (context: ModelRequestContext) => Promise<void>,
    agentRevision?: string,
    stableOperationId?: string,
  ) {
    const scope = runs.getStore();
    if (!scope) throw new Error("A trusted n8n server run is required for Model Request Context.");
    if (!previous && stableOperationId) {
      try {
        const filename = path.join(config.journalDirectory, `${stableOperationId}.json`);
        await lstat(filename);
        previous = JSON.parse(await readPrivateFile(filename, 8192)) as ModelRequestContext;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (previous) {
      validateContext(previous);
      if (
        previous.installationId !== config.installationId ||
        previous.projectId !== scope.identity.projectId ||
        previous.conversationId !== scope.identity.conversationId ||
        previous.branchId !== scope.identity.branchId ||
        previous.runId !== runId
      )
        throw new Error("Checkpoint request context belongs to a different server run.");
      remember(previous);
      if (kind === "turn") {
        scope.rootRunId ??= runId;
        scope.parentOperationId = previous.operationId;
      }
      return previous;
    }
    if (kind === "turn") scope.rootRunId ??= runId;
    const context: ModelRequestContext = {
      version: 1,
      installationId: config.installationId,
      projectId: scope.identity.projectId,
      agentRevision: agentRevision ?? scope.identity.agentRevision,
      conversationId: scope.identity.conversationId,
      branchId: scope.identity.branchId,
      runId,
      turnId: scope.identity.turnId,
      operationId: stableOperationId ?? randomUUID(),
      operationIssuedAt: stableOperationId
        ? (scope.identity.hostIssuedAt ?? Date.now())
        : Date.now(),
      kind:
        kind === "turn"
          ? (scope.identity.kind ?? (scope.rootRunId !== runId ? "subagent" : "turn"))
          : kind,
      cause,
      ...((operations.getStore()?.operationId ?? scope.parentOperationId)
        ? { parentOperationId: operations.getStore()?.operationId ?? scope.parentOperationId }
        : {}),
    };
    validateContext(context);
    // Non-content durable journal plus checkpoint commit precede every provider send.
    await persistJournal(config.journalDirectory, context);
    await persist?.(context);
    for (const [id, existing] of knownOperations)
      if (existing.operationIssuedAt < Date.now() - 86400000) knownOperations.delete(id);
    remember(context);
    if (kind === "turn" && scope.rootRunId === runId) scope.parentOperationId = context.operationId;
    return Object.freeze(context);
  }
  installed = {
    prepare: async (input, persist) => {
      const scope = runs.getStore();
      if (!scope) return undefined;
      if (input.parentOperationId) scope.parentOperationId = input.parentOperationId;
      return allocate(
        input.runId,
        input.kind ?? "turn",
        input.previous,
        input.cause,
        persist,
        input.agentRevision,
      );
    },
    run: (context, action) => (context ? operations.run(context, action) : action()),
    decorateModel: <T>(model: T, kind?: ModelRequestContext["kind"]): T => {
      if (!runs.getStore() || !model || typeof model !== "object") return model;
      const captured = kind ? undefined : operations.getStore();
      let pending: Promise<ModelRequestContext>;
      if (captured) pending = Promise.resolve(captured);
      else {
        const scope = runs.getStore()!,
          helperKind = kind ?? "helper";
        const parent = operations.getStore()?.operationId ?? scope.parentOperationId ?? "";
        const slot = `${parent}:${helperKind}`,
          ordinal = scope.helperCounts.get(slot) ?? 0;
        scope.helperCounts.set(slot, ordinal + 1);
        const digest = createHmac("sha256", key)
          .update(
            JSON.stringify([
              "helper-slot-v1",
              config.installationId,
              scope.identity.projectId,
              scope.identity.conversationId,
              scope.identity.branchId,
              scope.identity.hostRunId,
              parent,
              helperKind,
              ordinal,
            ]),
          )
          .digest("hex")
          .slice(0, 32);
        const operationId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
        pending = allocate(
          `helper_${operationId}`,
          helperKind,
          undefined,
          "generation",
          undefined,
          undefined,
          operationId,
        );
      }
      return new Proxy(model as object, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if ((property !== "doGenerate" && property !== "doStream") || typeof value !== "function")
            return typeof value === "function" ? value.bind(target) : value;
          return async (options: Record<string, unknown>) => {
            const context = await pending;
            // This opaque local marker contains no credential. Only the exact-origin
            // server fetch decorator may replace it with a signed attestation.
            const headers = {
              ...(options.headers as Record<string, string> | undefined),
              "X-N8n-Model-Operation": context.operationId,
            };
            return await value.call(target, { ...options, headers });
          };
        },
      }) as T;
    },
    decorateFetch: (fetch) => decorateModelFetch(fetch),
  };
  (globalThis as Record<symbol, unknown>)[CONTEXT_HOOK_SYMBOL] = installed;
  return installed;
}

/** Strip internal headers for every non-gateway provider, even when a helper chooses it. */
export function decorateModelFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (!process.env.N8N_CODEX_CONTEXT_CONFIG_FILE) return fetchImpl(input, init);
    const { config, key } = await settings();
    const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      ),
      headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
    const operationId = headers.get("X-N8n-Model-Operation");
    headers.delete("X-N8n-Model-Operation");
    headers.delete("X-Codex-Wire-Context");
    headers.delete("X-Codex-Wire-Installation-Key");
    headers.delete("X-Codex-Wire-Context-Handshake");
    const attested = config.gatewayOrigins.includes(url.origin) && url.pathname === "/v1/responses";
    if (attested) {
      const scope = runs.getStore();
      if (!scope) throw new Error("A trusted n8n server run is required for gateway attestation.");
      if (
        !Number.isSafeInteger(scope.identity.hostIssuedAt) ||
        scope.identity.hostIssuedAt! > Date.now() + 30000 ||
        scope.identity.hostIssuedAt! < Date.now() - 86400000
      )
        throw new Error(
          "The trusted host execution time is unavailable or outside its immutable retry window.",
        );
      let context = operationId ? knownOperations.get(operationId) : undefined;
      if (!context && operationId && /^[a-f0-9-]{36}$/.test(operationId)) {
        try {
          const saved = JSON.parse(
            await readPrivateFile(path.join(config.journalDirectory, `${operationId}.json`), 8192),
          ) as ModelRequestContext;
          validateContext(saved);
          if (saved.operationId !== operationId || saved.installationId !== config.installationId)
            throw new Error("Context journal identity differs.");
          context = saved;
          remember(saved);
        } catch {
          throw new Error("The durable model operation is unavailable or expired.");
        }
      }
      if (!context)
        throw new Error(
          "The matched lifecycle hook did not supply a durable model operation context.",
        );
      validateContext(context);
      if (
        context.projectId !== scope.identity.projectId ||
        context.conversationId !== scope.identity.conversationId ||
        context.branchId !== scope.identity.branchId
      )
        throw new Error("The model operation belongs to a different trusted branch.");
      let pending = handshakes.get(url.origin),
        handshake = pending ? await pending : undefined;
      if (!handshake || handshake.expires < Date.now() + 60000) {
        pending = (async () => {
          const response = await fetchImpl(`${url.origin}/wire/v1/context/handshake`, {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify(require("./context-build.json")),
            redirect: "error",
            signal: init?.signal,
          });
          if (!response.ok)
            throw new Error("The gateway rejected the matched lifecycle handshake.");
          const value = (await response.json()) as { id: string; expires: number };
          if (
            typeof value.id !== "string" ||
            value.id.length > 100 ||
            !Number.isSafeInteger(value.expires)
          )
            throw new Error("Invalid lifecycle handshake response.");
          return value;
        })();
        handshakes.set(url.origin, pending);
        try {
          handshake = await pending;
        } catch (error) {
          handshakes.delete(url.origin);
          throw error;
        }
      }
      headers.set("X-Codex-Wire-Context", attestContext(context, key));
      headers.set("X-Codex-Wire-Installation-Key", key);
      headers.set("X-Codex-Wire-Context-Handshake", handshake.id);
    }
    const response = await fetchImpl(input, {
      ...init,
      headers,
      ...(attested ? { redirect: "error" as const } : {}),
    });
    if (attested && (response.redirected || (response.status >= 300 && response.status < 400)))
      throw new Error("Attested model requests cannot follow redirects.");
    return response;
  };
}
export function revisionIdentity(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
