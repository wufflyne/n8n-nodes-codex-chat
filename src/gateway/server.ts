import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { GatewayEngine } from "./engine.js";
import { GatewayAuthorization } from "./auth.js";
import { ConsoleAuthentication } from "./control-auth.js";
import { GatewayControl } from "./control.js";
import type { GatewayConfig } from "./config.js";
import { verifyContext } from "./context.js";
import { dispatchRpc, validateRpc } from "./rpc.js";
import { EventChannel, PublicResponseStream } from "./stream.js";
import { parseResponses } from "./responses.js";
import { errorBody, invalid, WireError, wireError } from "./errors.js";
import { EmbeddedService } from "../service/embedded.js";
import { AdmissionRejection } from "../core/transport.js";
import {
  BodyMemoryAdmission,
  gatewayMemory,
  requestMemory,
  type MemoryLease,
} from "./pool/memory.js";
import { accountIdentityKey, executionKey } from "../core/affinity.js";
import type { TransportEvent } from "../core/transport.js";
import type { OperationStore } from "./state/operations.js";
import { ContextHandshake } from "./context-handshake.js";
import type { PendingAdmissionBudget } from "./pool/admission.js";

const MAX_BODY = 32 * 1024 * 1024;
// The Node bridge transfers one bounded buffer without copying it into Fetch's body storage.
const receivedBodies = new WeakMap<Request, Buffer>();
function parseBody(bytes: Buffer) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid("body", "The request body is not valid JSON.");
  }
}
async function body(request: Request) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY)
    throw new WireError(
      413,
      "request_too_large",
      "The request exceeds 32 MiB.",
    );
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    invalid("content_type", "Use application/json.");
  const received = receivedBodies.get(request);
  if (received) {
    receivedBodies.delete(request);
    return parseBody(received);
  }
  const reader = request.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  if (!reader) invalid("body");
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new WireError(
          413,
          "request_too_large",
          "The request exceeds 32 MiB.",
        );
      }
      chunks.push(next.value);
    }
    const bytes = Buffer.concat(chunks, size);
    chunks.length = 0;
    return parseBody(bytes);
  } finally {
    chunks.length = 0;
    reader.releaseLock();
  }
}
function receivedRequest(
  url: URL,
  init: RequestInit,
  chunks: Buffer[],
  size: number,
) {
  try {
    const request = new Request(url, init);
    if (size) receivedBodies.set(request, Buffer.concat(chunks, size));
    return request;
  } finally {
    chunks.length = 0;
  }
}
function bearer(request: Request) {
  const match = /^Bearer (.+)$/.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match)
    throw new WireError(
      401,
      "invalid_key",
      "A gateway bearer key is required.",
    );
  return match[1]!;
}
function json(value: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}
function holdArtifact(response: Response, release: () => void) {
  const reader = response.body!.getReader();
  return new Response(
    new ReadableStream(
      {
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              release();
              controller.close();
            } else controller.enqueue(next.value);
          } catch (error) {
            release();
            controller.error(error);
          }
        },
        async cancel() {
          try {
            await reader.cancel();
          } finally {
            release();
          }
        },
      },
      { highWaterMark: 0 },
    ),
    { status: response.status, headers: response.headers },
  );
}
function sse(
  events:
    | Iterable<Record<string, unknown>>
    | AsyncIterable<Record<string, unknown>>,
) {
  const iterator =
      Symbol.asyncIterator in events
        ? (events as AsyncIterable<Record<string, unknown>>)[
            Symbol.asyncIterator
          ]()
        : (async function* () {
            yield* events as Iterable<Record<string, unknown>>;
          })(),
    encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const next = await iterator.next();
            if (next.done) {
              controller.close();
              return;
            }
            controller.enqueue(
              encoder.encode(
                `event: ${next.value.type}\ndata: ${JSON.stringify(next.value)}\n\n`,
              ),
            );
          } catch {
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({ type: "error", sequence_number: Number.MAX_SAFE_INTEGER, error: { type: "outcome_unknown", code: "422", message: "The stream did not finish safely.", param: null } })}\n\n`,
              ),
            );
            controller.close();
          }
        },
        async cancel() {
          await iterator.return?.();
        },
      },
      { highWaterMark: 1 },
    ),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    },
  );
}
export class GatewayApplication {
  readonly authorization: GatewayAuthorization;
  readonly consoleAuth: ConsoleAuthentication;
  readonly control: GatewayControl;
  readonly service: EmbeddedService;
  readonly contextHandshake: ContextHandshake;
  private readonly rpcActive = new Map<
    string,
    { controller: AbortController; execution: string }
  >();
  private cleanupTimer?: NodeJS.Timeout;
  private readonly backgroundWork = new Set<Promise<unknown>>();
  private track(work: Promise<unknown>) {
    this.backgroundWork.add(work);
    void work
      .finally(() => this.backgroundWork.delete(work))
      .catch(() => undefined);
  }
  async settle() {
    while (this.backgroundWork.size)
      await Promise.allSettled([...this.backgroundWork]);
  }
  abortActive() {
    for (const active of this.rpcActive.values()) active.controller.abort();
  }
  constructor(
    readonly config: GatewayConfig,
    readonly engine: GatewayEngine,
  ) {
    this.contextHandshake = new ContextHandshake(engine.state);
    this.authorization = new GatewayAuthorization(engine.state);
    this.consoleAuth = new ConsoleAuthentication(
      engine.state,
      config.admin.bootstrapFile,
    );
    this.control = new GatewayControl(
      engine.resources,
      engine.state,
      this.authorization,
      engine.contextQualified,
    );
    this.service = new EmbeddedService(engine.resources);
  }
  async initialize() {
    await this.consoleAuth.initialize();
    await this.engine.state.cleanup();
    this.cleanupTimer = setInterval(() => {
      this.track(this.engine.state.cleanup().catch(() => undefined));
    }, 15 * 60000);
    this.cleanupTimer.unref();
  }
  stopMaintenance() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
  async preflight(request: Request, admin: boolean) {
    const url = new URL(request.url);
    if (!admin) {
      const role = url.pathname.startsWith("/wire/")
          ? "installation"
          : "inference",
        key = await this.authorization.authenticate(bearer(request), role);
      if (role === "inference")
        await this.authorization.policy(key.connectionId ?? "");
      return;
    }
    const expected = new URL(this.config.admin.origin);
    if (
      url.host !== expected.host ||
      (request.headers.get("host") &&
        request.headers.get("host") !== expected.host)
    )
      throw new WireError(403, "host", "The administration host is invalid.");
    if (
      request.method === "GET" &&
      [
        "/",
        "/console.js",
        "/console.css",
        "/codex.svg",
        "/control/v1/session",
      ].includes(url.pathname)
    )
      return;
    if (
      ["/control/v1/bootstrap", "/control/v1/login"].includes(url.pathname) &&
      request.method === "POST"
    )
      return;
    if (request.headers.has("authorization")) {
      await this.authorization.authenticate(bearer(request), "administrator");
      return;
    }
    const cookie = (request.headers.get("cookie") ?? "")
      .split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("codex_wire_session="))
      ?.slice(19);
    await this.consoleAuth.session(
      cookie,
      request.headers.get("x-csrf-token") ?? undefined,
      request.method !== "GET",
    );
  }
  async inference(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.search) invalid("query");
      if (url.pathname.startsWith("/wire/")) {
        const key = await this.authorization.authenticate(
          bearer(request),
          "installation",
        );
        if (
          url.pathname === "/wire/v1/context/handshake" &&
          request.method === "POST"
        ) {
          if (!this.engine.contextQualified)
            throw new WireError(
              422,
              "context_not_qualified",
              "The operator has not qualified this lifecycle integration.",
            );
          return json(
            await this.contextHandshake.issue(key, await body(request)),
          );
        }
        if (url.pathname === "/wire/v1/handshake" && request.method === "GET")
          return json({
            protocolVersion: 1,
            release: "0.1.0",
            schemaVersion: 1,
            features: [
              "native-rpc-v1",
              ...(this.engine.contextQualified ? ["request-context-v1"] : []),
            ],
            singleOwner: true,
          });
        if (url.pathname !== "/wire/v1/rpc" || request.method !== "POST")
          throw new WireError(
            400,
            "unsupported_native_route",
            "Use the versioned native RPC contract.",
          );
        const envelope = validateRpc(await body(request), key),
          activeKey = `${key.id}:${envelope.operationId}`;
        if (envelope.method === "cancel") {
          const target = String(envelope.params.operationId ?? "");
          const active = this.rpcActive.get(`${key.id}:${target}`);
          if (active && active.execution !== executionKey(envelope.execution!))
            throw new WireError(
              403,
              "execution_scope",
              "Cancellation belongs to another execution.",
            );
          active?.controller.abort();
          return json({ cancelled: true });
        }
        if (this.rpcActive.has(activeKey))
          throw new WireError(
            422,
            "operation_in_flight",
            "This native operation is already running.",
          );
        const controller = new AbortController(),
          signal = AbortSignal.any([request.signal, controller.signal]);
        this.rpcActive.set(activeKey, {
          controller,
          execution: envelope.execution ? executionKey(envelope.execution) : "",
        });
        let artifactRelease: (() => void) | undefined;
        let admissionRelease: (() => void) | undefined;
        let operation: Awaited<ReturnType<OperationStore["begin"]>> | undefined;
        try {
          if (
            ["generate", "image", "reset", "reconcile"].includes(
              envelope.method,
            )
          ) {
            const profile = await this.engine.resources.store.read(
              envelope.binding!,
            );
            admissionRelease = await this.engine.queue.acquire(
              accountIdentityKey(profile),
              null,
              signal,
            );
          }
          if (envelope.method === "image")
            artifactRelease =
              requestMemory.get(request)?.tryExtend(272 * 1024 * 1024) ??
              gatewayMemory.tryAcquireBytes(272 * 1024 * 1024);
          if (
            ["generate", "image", "reset", "reconcile"].includes(
              envelope.method,
            )
          ) {
            const x = envelope.execution!;
            operation = await this.engine.operations.begin(
              `native:${key.installationId}`,
              {
                version: 1,
                installationId: key.installationId!,
                projectId: x.workflowId,
                agentRevision: x.nodeId,
                conversationId: x.executionId,
                branchId: x.nodeId,
                runId: x.executionId,
                turnId: x.nodeId,
                operationId: envelope.operationId,
                operationIssuedAt: envelope.operationIssuedAt,
                kind: "turn",
              },
              envelope,
              false,
            );
          }
          const nativeChannel =
            envelope.method === "generate"
              ? new EventChannel(() => controller.abort())
              : undefined;
          const result = await dispatchRpc(
            this.service,
            envelope,
            signal,
            nativeChannel
              ? () => nativeChannel.write({ type: "wire.admitted" })
              : undefined,
          );
          if (nativeChannel) {
            const handle = operation!;
            this.track(
              (async () => {
                let complete = false;
                try {
                  for await (const event of result as AsyncIterable<TransportEvent>) {
                    if (event.kind === "completed") {
                      await this.engine.operations.finish(handle, "completed");
                      complete = true;
                    }
                    await nativeChannel.write({ type: "wire.event", event });
                  }
                } catch (error) {
                  try {
                    await nativeChannel.write({
                      type: "wire.error",
                      message: errorBody(error).error.message,
                      code:
                        error instanceof AdmissionRejection
                          ? "quota_rejected"
                          : errorBody(error).error.code,
                      accepted:
                        error instanceof AdmissionRejection ? false : undefined,
                    });
                  } catch {
                    /* A disconnected reader has already cancelled this channel. */
                  }
                } finally {
                  if (!complete)
                    try {
                      await this.engine.operations.finish(handle, "unknown");
                    } catch {
                      /* The durable intent already fences retry. */
                    }
                  admissionRelease?.();
                  this.rpcActive.delete(activeKey);
                  nativeChannel.close();
                }
              })(),
            );
            return sse(nativeChannel);
          }
          if (operation)
            await this.engine.operations.finish(operation, "completed");
          admissionRelease?.();
          this.rpcActive.delete(activeKey);
          const response = json(result);
          return artifactRelease
            ? holdArtifact(response, artifactRelease)
            : response;
        } catch (error) {
          if (operation)
            try {
              await this.engine.operations.finish(operation, "unknown");
            } catch {
              /* Preserve the durable intent. */
            }
          artifactRelease?.();
          admissionRelease?.();
          this.rpcActive.delete(activeKey);
          throw error;
        }
      }
      const key = await this.authorization.authenticate(
          bearer(request),
          "inference",
        ),
        policy = await this.authorization.policy(key.connectionId ?? "");
      const requiredScope =
        url.pathname === "/v1/models" ? "models" : "responses";
      if (!key.scopes.includes(requiredScope))
        throw new WireError(
          403,
          "inference_scope",
          "This inference key does not permit the requested operation.",
        );
      if (url.pathname === "/v1/models" && request.method === "GET")
        return json(await this.engine.models(policy, request.signal));
      if (url.pathname === "/v1/responses" && request.method === "POST") {
        let context;
        const encoded = request.headers.get("x-codex-wire-context"),
          installationKey = request.headers.get(
            "x-codex-wire-installation-key",
          );
        if (encoded || installationKey) {
          if (!encoded || !installationKey)
            throw new WireError(
              401,
              "context_incomplete",
              "Both context authentication headers are required.",
            );
          const installation = await this.authorization.authenticate(
            installationKey,
            "installation",
          );
          if (
            !installation.scopes.includes("context:attest") ||
            !installation.connections?.includes(policy.id)
          )
            throw new WireError(
              403,
              "context_scope",
              "This installation cannot attest requests for this connection.",
            );
          context = verifyContext(encoded, installationKey);
          if (
            context.installationId !== installation.installationId ||
            (policy.installationId &&
              policy.installationId !== context.installationId)
          )
            throw new WireError(
              403,
              "context_scope",
              "The installation and connection identity do not match.",
            );
          if (policy.mode === "pool")
            await this.contextHandshake.verify(
              installation,
              request.headers.get("x-codex-wire-context-handshake"),
            );
        }
        const raw = await body(request),
          parsed = parseResponses(raw);
        if (!parsed.stream)
          return json(
            (
              await this.engine.respond(
                policy,
                raw,
                context,
                request.signal,
                undefined,
                requestMemory.get(request),
              )
            ).body,
          );
        const cancel = new AbortController(),
          signal = AbortSignal.any([request.signal, cancel.signal]),
          channel = new EventChannel(() => cancel.abort());
        let admitted = false,
          resolveReady!: () => void,
          rejectReady!: (error: unknown) => void;
        const ready = new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });
        const stream = new PublicResponseStream(
          parsed.model,
          parsed.store,
          () => {
            admitted = true;
            resolveReady();
          },
          (event) => channel.write(event),
        );
        this.track(
          this.engine
            .respond(
              policy,
              raw,
              context,
              signal,
              stream,
              requestMemory.get(request),
            )
            .then(async (result) => {
              await stream.finish(result.body);
            })
            .catch(async (error) => {
              if (!admitted) rejectReady(error);
              else
                try {
                  await stream.fail(error);
                } catch {
                  /* A disconnected client cannot receive a terminal event. */
                }
            })
            .finally(() => channel.close()),
        );
        await ready;
        return sse(channel);
      }
      if (url.pathname === "/v1/chat/completions")
        throw new WireError(
          400,
          "assistant_not_qualified",
          "The optional Assistant Chat adapter is not enabled in this release qualification.",
        );
      throw new WireError(
        400,
        "unsupported_route",
        "This bounded facade supports models and Responses creation only.",
      );
    } catch (error) {
      if (error instanceof AdmissionRejection)
        return json(
          {
            error: {
              message: error.message,
              type: "invalid_request_error",
              code: "quota_rejected",
              param: null,
            },
          },
          429,
        );
      return json(errorBody(error), wireError(error).status);
    }
  }
  async admin(request: Request): Promise<Response> {
    const secure = new URL(this.config.admin.origin).protocol === "https:",
      security = {
        "content-security-policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      };
    try {
      const url = new URL(request.url),
        expected = new URL(this.config.admin.origin);
      if (
        url.host !== expected.host ||
        (request.headers.get("host") &&
          request.headers.get("host") !== expected.host)
      )
        throw new WireError(403, "host", "The administration host is invalid.");
      if (
        request.method !== "GET" &&
        !request.headers.has("authorization") &&
        request.headers.get("origin") !== expected.origin
      )
        throw new WireError(
          403,
          "origin",
          "The administration origin is invalid.",
        );
      if (url.search) invalid("query");
      if (
        request.method === "GET" &&
        ["/", "/console.js", "/console.css", "/codex.svg"].includes(
          url.pathname,
        )
      ) {
        const file =
            url.pathname === "/" ? "index.html" : url.pathname.slice(1),
          data = await readFile(path.join(__dirname, "console", file));
        return new Response(data, {
          headers: {
            ...security,
            "cache-control": "no-store",
            "content-type": file.endsWith("html")
              ? "text/html; charset=utf-8"
              : file.endsWith("js")
                ? "text/javascript; charset=utf-8"
                : file.endsWith("css")
                  ? "text/css; charset=utf-8"
                  : "image/svg+xml",
          },
        });
      }
      const cookie = (request.headers.get("cookie") ?? "")
        .split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith("codex_wire_session="))
        ?.slice(19);
      if (url.pathname === "/control/v1/session" && request.method === "GET") {
        const setup = await this.consoleAuth.status();
        if (!setup.initialized)
          return json({ ...setup, authenticated: false }, 200, security);
        try {
          const session = await this.consoleAuth.session(cookie);
          return json(
            { ...setup, authenticated: true, csrf: session.csrf },
            200,
            security,
          );
        } catch {
          return json({ ...setup, authenticated: false }, 200, security);
        }
      }
      if (
        ["/control/v1/bootstrap", "/control/v1/login"].includes(url.pathname) &&
        request.method === "POST"
      ) {
        const p = (await body(request)) as Record<string, string>,
          actor = request.headers.get("x-wire-client-address") ?? "local";
        const session = url.pathname.endsWith("bootstrap")
          ? await this.consoleAuth.bootstrap(p.token!, p.passphrase!, actor)
          : await this.consoleAuth.login(p.passphrase!, actor);
        return json({ authenticated: true, csrf: session.csrf }, 200, {
          ...security,
          "set-cookie": `codex_wire_session=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? "; Secure" : ""}`,
        });
      }
      if (request.headers.has("authorization")) {
        const key = await this.authorization.authenticate(
          bearer(request),
          "administrator",
        );
        if (!key.scopes.includes("control:*"))
          throw new WireError(
            403,
            "wrong_scope",
            "This administration key cannot access the control plane.",
          );
      } else
        await this.consoleAuth.session(
          cookie,
          request.headers.get("x-csrf-token") ?? undefined,
          request.method !== "GET",
        );
      const p =
        request.method === "POST"
          ? ((await body(request)) as Record<string, unknown>)
          : {};
      let result: unknown;
      if (url.pathname === "/control/v1/accounts" && request.method === "GET")
        result = await this.control.accounts();
      else if (
        url.pathname === "/control/v1/connections" &&
        request.method === "GET"
      )
        result = await this.control.policies();
      else if (
        url.pathname === "/control/v1/deliveries" &&
        request.method === "GET"
      )
        result = await this.control.pendingDeliveries();
      else if (
        url.pathname === "/control/v1/connections" &&
        request.method === "POST"
      )
        result = await this.control.createConnection(p);
      else if (url.pathname === "/control/v1/keys" && request.method === "GET")
        result = {
          keys: (
            await this.engine.state.list<import("./auth.js").KeyRecord>(
              this.authorization.owner,
              256,
              "key:",
            )
          ).map(({ value: k }) => ({
            id: k.id,
            role: k.role,
            active: k.active,
            revoked: k.revoked === true,
            installationId: k.installationId,
            connectionId: k.connectionId,
            scopes: k.scopes,
          })),
        };
      else if (
        url.pathname === "/control/v1/keys/revoke" &&
        request.method === "POST"
      ) {
        if (
          Object.keys(p).some((name) => name !== "id") ||
          typeof p.id !== "string"
        )
          invalid("key");
        await this.authorization.revoke(p.id);
        result = { revoked: true };
      } else if (
        url.pathname === "/control/v1/administrators" &&
        request.method === "POST"
      )
        result = await this.authorization.prepareKey({
          role: "administrator",
          scopes: ["control:*"],
        });
      else if (
        url.pathname === "/control/v1/installations" &&
        request.method === "POST"
      )
        result = await this.control.createInstallation(p);
      else if (
        url.pathname === "/control/v1/limits" &&
        request.method === "POST"
      )
        result = await this.control.refresh(String(p.profileId));
      else if (
        url.pathname === "/control/v1/import" &&
        request.method === "POST"
      )
        result = await this.control.importAccount(p);
      else if (
        url.pathname === "/control/v1/device" &&
        request.method === "POST"
      )
        result = await this.control.startDevice(
          String(p.label),
          typeof p.reconnectProfileId === "string"
            ? p.reconnectProfileId
            : undefined,
        );
      else if (
        url.pathname === "/control/v1/device/status" &&
        request.method === "POST"
      )
        result = this.control.device(String(p.id));
      else if (
        url.pathname === "/control/v1/device/cancel" &&
        request.method === "POST"
      )
        result = this.control.cancelDevice(String(p.id));
      else if (
        url.pathname === "/control/v1/delivery" &&
        request.method === "POST"
      )
        result = await this.control.delivery(String(p.id));
      else if (
        url.pathname === "/control/v1/delivery/acknowledge" &&
        request.method === "POST"
      )
        result = await this.control.acknowledge(String(p.id));
      else if (
        url.pathname === "/control/v1/connections/disable" &&
        request.method === "POST"
      )
        result = await this.control.disableConnection(String(p.id));
      else if (
        url.pathname === "/control/v1/connections/update" &&
        request.method === "POST"
      )
        result = await this.control.updateConnection(p);
      else if (
        url.pathname === "/control/v1/retention/delete" &&
        request.method === "POST"
      )
        result = await this.control.purgeHistory(
          String(p.id),
          this.engine.queue.activeCount + this.rpcActive.size,
        );
      else if (
        url.pathname === "/control/v1/logout" &&
        request.method === "POST"
      ) {
        await this.consoleAuth.logout(cookie!);
        return json({ authenticated: false }, 200, {
          ...security,
          "set-cookie":
            "codex_wire_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        });
      } else if (
        url.pathname === "/control/v1/activity" &&
        request.method === "GET"
      )
        result = {
          recent: await this.engine.state.recent(
            this.engine.state.scope("activity"),
            100,
          ),
          inferenceOrigin: this.config.inference.origin,
          activeRequests: this.engine.queue.activeCount,
          usageCoverage: "Unknown outside reported gateway operations",
          retention: { ...this.engine.resolver.retention, operationHours: 48 },
          limits: {
            admission: this.engine.queue.limits,
            state: {
              globalBytes: this.engine.state.limits.globalBytes,
              connectionBytes: this.engine.state.limits.ownerBytes,
            },
          },
          contextQualified: this.engine.contextQualified,
        };
      else
        throw new WireError(
          400,
          "unsupported_control_operation",
          "Choose a supported administration operation.",
        );
      return json(result, 200, security);
    } catch (error) {
      return json(errorBody(error), wireError(error).status, security);
    }
  }
}

async function bridge(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  origin: string,
  handle: (r: Request) => Promise<Response>,
  memory: BodyMemoryAdmission,
  preflight: (r: Request) => Promise<void>,
  admin: boolean,
  pending: PendingAdmissionBudget,
) {
  const controller = new AbortController();
  outgoing.once("close", () => {
    if (!outgoing.writableEnded) controller.abort();
  });
  incoming.once("aborted", () => controller.abort());
  let release: MemoryLease | undefined;
  let responseReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers))
      if (value !== undefined)
        headers.set(name, Array.isArray(value) ? value.join(",") : value);
    headers.set(
      "x-wire-client-address",
      incoming.socket.remoteAddress ?? "unknown",
    );
    await preflight(
      new Request(new URL(incoming.url ?? "/", origin), {
        method: incoming.method,
        headers,
        signal: controller.signal,
      }),
    );
    // Paused incoming sockets retain only Node's bounded high-water buffer while queued.
    const declared = incoming.headers["content-length"];
    if (admin && declared !== undefined && Number(declared) > 512 * 1024)
      throw new WireError(
        413,
        "request_too_large",
        "Control requests are limited to 512 KiB.",
      );
    release = await (admin &&
    !["GET", "HEAD"].includes(incoming.method ?? "GET")
      ? memory.acquireBytes(
          8 * 1024 * 1024 +
            4 * (declared === undefined ? 512 * 1024 : Number(declared)),
          controller.signal,
          pending,
        )
      : memory.acquireRequest(
          incoming.method ?? "GET",
          declared === undefined ? undefined : Number(declared),
          incoming.headers["transfer-encoding"] !== undefined,
          controller.signal,
          pending,
        ));
    incoming.setTimeout(15000, () => {
      controller.abort();
      incoming.destroy();
    });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const raw of incoming) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.length;
      if (size > (admin ? 512 * 1024 : MAX_BODY))
        throw new WireError(
          413,
          "request_too_large",
          "The request exceeds its body limit.",
        );
      chunks.push(chunk);
    }
    incoming.setTimeout(0);
    const request = receivedRequest(
      new URL(incoming.url ?? "/", origin),
      {
        method: incoming.method,
        headers,
        signal: controller.signal,
      },
      chunks,
      size,
    );
    requestMemory.set(request, release);
    let response: Response;
    try {
      response = await handle(request);
    } finally {
      receivedBodies.delete(request);
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    responseReader = response.body?.getReader();
    if (responseReader)
      while (true) {
        const next = await responseReader.read();
        if (next.done) break;
        if (outgoing.destroyed) throw new Error("The client disconnected.");
        if (!outgoing.write(Buffer.from(next.value)))
          await waitForDrain(outgoing);
      }
    outgoing.end();
  } catch (error) {
    controller.abort();
    if (!outgoing.headersSent) {
      const e = wireError(error);
      outgoing.writeHead(e.status, {
        "content-type": "application/json",
        connection: "close",
      });
      outgoing.end(JSON.stringify(errorBody(e)));
    } else outgoing.destroy();
  } finally {
    await responseReader?.cancel().catch(() => undefined);
    release?.();
  }
}
async function waitForDrain(response: ServerResponse) {
  if (response.destroyed) throw new Error("The client disconnected.");
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      response.removeListener("drain", drain);
      response.removeListener("close", close);
      response.removeListener("error", failed);
      if (error) reject(error);
      else resolve();
    };
    const drain = () => finish(),
      close = () => finish(new Error("The client disconnected.")),
      failed = (error: Error) => finish(error);
    const timer = setTimeout(
      () => finish(new Error("The client stopped reading.")),
      15000,
    );
    timer.unref();
    response.once("drain", drain);
    response.once("close", close);
    response.once("error", failed);
  });
}
export async function listen(
  application: GatewayApplication,
): Promise<{ close: () => Promise<void> }> {
  const servers: Server[] = [];
  const memory = gatewayMemory;
  const bridges = new Set<Promise<void>>();
  let ready = false;
  try {
    for (const [configuration, handler, origin] of [
      [
        application.config.inference,
        application.inference.bind(application),
        "http://gateway.internal",
      ],
      [
        application.config.admin,
        application.admin.bind(application),
        application.config.admin.origin,
      ],
    ] as const) {
      const admin = configuration === application.config.admin;
      const server = createServer({ maxHeaderSize: 16384 }, (req, res) => {
        if (!ready) {
          res.writeHead(503, {
            "content-type": "application/json",
            connection: "close",
          });
          res.end(
            JSON.stringify(
              errorBody(
                new WireError(
                  503,
                  "starting",
                  "The gateway is not ready; no request was admitted.",
                ),
              ),
            ),
          );
          return;
        }
        const work = bridge(
          req,
          res,
          origin,
          handler,
          memory,
          (r) => application.preflight(r, admin),
          admin,
          application.engine.queue.pending,
        );
        bridges.add(work);
        void work.finally(() => bridges.delete(work)).catch(() => undefined);
      });
      server.maxConnections = 128;
      server.requestTimeout = 300000;
      server.headersTimeout = 10000;
      server.keepAliveTimeout = 5000;
      servers.push(server);
      server.listen(configuration.port, configuration.host);
      await once(server, "listening");
    }
    ready = true;
  } catch (error) {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    throw error;
  }
  return {
    close: async () => {
      ready = false;
      application.stopMaintenance();
      application.engine.queue.drain();
      const deviceWork = application.control.close();
      const connections = Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
              server.closeIdleConnections();
            }),
        ),
      );
      const handlers = (async () => {
        await connections;
        while (bridges.size) await Promise.allSettled([...bridges]);
        await application.settle();
      })();
      const settled = Promise.all([handlers, deviceWork]);
      // A bounded drain never transfers ownership while an asynchronous commit is live.
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          settled,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              application.abortActive();
              for (const server of servers) server.closeAllConnections();
              reject(
                new Error(
                  "Gateway drain did not settle; preserve the owner fence.",
                ),
              );
            }, 60000);
            timer.unref();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
