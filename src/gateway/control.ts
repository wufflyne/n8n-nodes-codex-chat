import { readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { record } from "../core/errors.js";
import { parseManualTokens } from "../auth/sessions.js";
import { deliverEncryptedBinding } from "../auth/connection.js";
import { verifiedAccess } from "../service/access.js";
import type { runtimeFromEnvironment } from "../runtime.js";
import type { StateRepository } from "./state/repository.js";
import {
  GatewayAuthorization,
  type ConnectionPolicy,
  type KeyRole,
  type KeyRecord,
} from "./auth.js";
import { invalid, terminal } from "./errors.js";
import { ContextHandshake } from "./context-handshake.js";

interface DeviceAttempt {
  state: "waiting" | "connected" | "cancelled" | "failed";
  url?: string;
  code?: string;
  expires: number;
  deliveryId: string;
  controller: AbortController;
  message?: string;
  settled: boolean;
}
export class GatewayControl {
  readonly owner: string;
  private readonly devices = new Map<string, DeviceAttempt>();
  private readonly deviceWork = new Set<Promise<void>>();
  private readonly deviceStarts = new Set<Promise<unknown>>();
  private closing = false;
  constructor(
    private readonly resources: ReturnType<typeof runtimeFromEnvironment>,
    private readonly state: StateRepository,
    readonly authorization: GatewayAuthorization,
    private readonly contextQualified: boolean,
  ) {
    this.owner = state.scope("control");
  }
  async accounts() {
    const files = await readdir(this.resources.store.directory),
      accounts = [];
    for (const file of files) {
      if (!/^[a-f0-9-]{36}\.json\.enc$/.test(file)) continue;
      const profileId = file.slice(0, -9),
        access = verifiedAccess(profileId, "administrator");
      const status = await this.resources.account.readLocalStatus(access),
        saved = await this.state.get(this.owner, `limits:${profileId}`);
      accounts.push({
        profileId,
        ...status,
        savedLimits: saved?.value ?? null,
      });
    }
    return { accounts };
  }
  async refresh(profileId: string) {
    const snapshot = await this.resources.account.readAccount(
      verifiedAccess(profileId, "administrator"),
      { force: true, includeResetDetails: true },
    );
    await this.state.transaction(
      [],
      [
        {
          owner: this.owner,
          id: `limits:${profileId}`,
          value: snapshot,
          expires: Number.MAX_SAFE_INTEGER,
        },
      ],
    );
    return snapshot;
  }
  async policies() {
    return {
      connections: (
        await this.state.list<ConnectionPolicy>(
          this.authorization.owner,
          256,
          "policy:",
        )
      ).map((e) => e.value),
    };
  }
  /** Protected metadata lets setup survive losing its first HTTP response. */
  async pendingDeliveries() {
    const deliveries: Array<{
      id: string;
      kind: string;
      name: string;
      expiresAt: string;
      connected?: boolean;
    }> = [];
    for (const entry of await this.state.list<{
      binding: { profileId: string };
      label: string;
    }>(this.owner, 256, "binding:")) {
      if (entry.expires <= Date.now()) continue;
      deliveries.push({
        id: entry.key.slice(8),
        kind: "account",
        name: entry.value.label,
        expiresAt: new Date(entry.expires).toISOString(),
        connected: await this.resources.store.exists(
          entry.value.binding.profileId,
        ),
      });
    }
    for (const entry of await this.state.list<{ id: string }>(
      this.authorization.owner,
      256,
      "delivery:",
    )) {
      if (entry.expires <= Date.now()) continue;
      const key = await this.state.get<KeyRecord>(
        this.authorization.owner,
        `key:${entry.value.id}`,
      );
      if (!key || key.value.active || key.value.revoked) continue;
      const policy = key.value.connectionId
        ? await this.state.get<ConnectionPolicy>(
            this.authorization.owner,
            `policy:${key.value.connectionId}`,
          )
        : undefined;
      deliveries.push({
        id: entry.key.slice(9),
        kind: key.value.role,
        name:
          policy?.value.name ?? key.value.installationId ?? "Operator helper",
        expiresAt: new Date(entry.expires).toISOString(),
      });
    }
    return { deliveries };
  }
  async createConnection(value: unknown) {
    const p = record(value);
    if (
      Object.keys(p).some(
        (k) =>
          ![
            "name",
            "mode",
            "profiles",
            "allowedModels",
            "installationId",
            "localContinuityConsent",
          ].includes(k),
      )
    )
      invalid("connection");
    const policy: ConnectionPolicy = {
      id: randomUUID(),
      name: String(p.name ?? ""),
      mode: p.mode as ConnectionPolicy["mode"],
      profiles: p.profiles as string[],
      allowedModels: (p.allowedModels ?? []) as string[],
      installationId: p.installationId as string | undefined,
      enabled: true,
      localContinuityConsent: p.localContinuityConsent === true,
      contextQualified: this.contextQualified,
    };
    if (policy.mode === "pool") {
      policy.enabled = false;
      policy.awaitingContext = true;
    }
    for (const id of policy.profiles ?? [])
      await this.resources.store.readId(id);
    await this.authorization.savePolicy(policy);
    const delivery = await this.authorization.prepareKey({
      role: "inference",
      scopes: ["models", "responses"],
      connectionId: policy.id,
    });
    return { connection: policy, ...delivery };
  }
  async createInstallation(value: unknown) {
    const p = record(value);
    if (
      Object.keys(p).some(
        (k) =>
          ![
            "installationId",
            "profiles",
            "connections",
            "allowReset",
            "contextOnly",
          ].includes(k),
      )
    )
      invalid("installation");
    if (
      typeof p.installationId !== "string" ||
      !p.installationId ||
      p.installationId.length > 256 ||
      !Array.isArray(p.profiles) ||
      !Array.isArray(p.connections)
    )
      invalid("installation");
    for (const id of p.profiles) await this.resources.store.readId(String(id));
    const scopes =
      p.contextOnly === true
        ? ["context:attest"]
        : [
            "native:*",
            "context:attest",
            ...(p.allowReset === true ? ["native:reset"] : []),
          ];
    return this.authorization.prepareKey({
      role: "installation" as KeyRole,
      scopes,
      installationId: p.installationId,
      profiles: p.profiles as string[],
      connections: p.connections as string[],
    });
  }
  private async prepared(label: string) {
    if (typeof label !== "string" || !label.trim() || label.length > 80)
      invalid("label");
    if ((await this.state.list(this.owner, 256, "binding:")).length >= 256)
      terminal(
        "delivery_capacity",
        "Complete pending account setup or wait for its delivery bundles to expire.",
      );
    const prepared = this.resources.sessions.prepareNewProfile(),
      deliveryId = randomUUID();
    const durable = await deliverEncryptedBinding(
      prepared.binding,
      async () => {
        await this.state.transaction(
          [],
          [
            {
              owner: this.owner,
              id: `binding:${deliveryId}`,
              value: { binding: prepared.binding, label, state: "pending" },
              expires: Date.now() + 3600000,
            },
          ],
        );
      },
    );
    return { prepared, deliveryId, durable };
  }
  async importAccount(value: unknown) {
    const p = record(value);
    if (
      Object.keys(p).some(
        (k) =>
          !["label", "format", "session", "reconnectProfileId"].includes(k),
      )
    )
      invalid("import");
    const tokens = parseManualTokens(
      p.session,
      p.format as "token-set" | "codex-auth-json",
    );
    if (p.reconnectProfileId) {
      const access = verifiedAccess(
          String(p.reconnectProfileId),
          "administrator",
        ),
        profile = await this.resources.store.read(access);
      await this.resources.sessions.reconnectAuthorized(
        access,
        tokens,
        profile.label,
      );
      return {
        profileId: profile.id,
        state: "connected",
        bindingPreserved: true,
      };
    }
    const setup = await this.prepared(p.label as string);
    await this.resources.sessions.activatePreparedProfile(
      setup.prepared,
      tokens,
      p.label as string,
      { bindingDurable: setup.durable },
    );
    return {
      deliveryId: setup.deliveryId,
      profileId: setup.prepared.binding.profileId,
      state: "connected",
    };
  }
  async startDevice(label: string, reconnectProfileId?: string) {
    if (this.closing)
      terminal("draining", "The gateway is closing account connections.");
    for (const [id, entry] of this.devices)
      if (entry.expires < Date.now() && entry.settled)
        this.devices.delete(id);
    // Status eviction never cancels/frees active or finalizing authentication work.
    for (const [id, entry] of this.devices) {
      if (this.devices.size + this.deviceStarts.size < 8) break;
      if (entry.settled) this.devices.delete(id);
    }
    if (this.devices.size + this.deviceStarts.size >= 8)
      terminal(
        "device_capacity",
        "Eight device-login attempts are starting, active or finalizing. Wait for one to finish. Completed setup remains recoverable under Connections.",
      );
    // Reserve before the first await, including durable pending-binding preparation.
    const start = this.beginDevice(label, reconnectProfileId);
    this.deviceStarts.add(start);
    try {
      return await start;
    } finally {
      this.deviceStarts.delete(start);
    }
  }
  private async beginDevice(label: string, reconnectProfileId?: string) {
    const access = reconnectProfileId
      ? verifiedAccess(reconnectProfileId, "administrator")
      : undefined;
    if (access) label = (await this.resources.store.read(access)).label;
    const setup = access ? undefined : await this.prepared(label);
    if (this.closing)
      terminal("draining", "The gateway is closing account connections.");
    const id = randomUUID(),
      controller = new AbortController(),
      entry: DeviceAttempt = {
        state: "waiting",
        expires: Date.now() + 15 * 60000,
        deliveryId: setup?.deliveryId ?? "",
        controller,
        settled: false,
      };
    this.devices.set(id, entry);
    const work = this.resources.auth
      .deviceLogin((url, code) => {
        entry.url = url;
        entry.code = code;
      }, controller.signal)
      .then(async (tokens) => {
        if (access)
          await this.resources.sessions.reconnectAuthorized(
            access,
            tokens,
            label,
            controller.signal,
          );
        else
          await this.resources.sessions.activatePreparedProfile(
            setup!.prepared,
            tokens,
            label,
            {
              bindingDurable: setup!.durable,
              signal: controller.signal,
            },
          );
        entry.state = "connected";
      })
      .catch(() => {
        entry.state = controller.signal.aborted ? "cancelled" : "failed";
        entry.message = controller.signal.aborted
          ? "Connection cancelled."
          : "Account connection did not complete. Start a new connection after checking the provider's device-login availability.";
      });
    this.deviceWork.add(work);
    void work.finally(() => {
      entry.settled = true;
      this.deviceWork.delete(work);
    });
    return { id, ...this.device(id) };
  }
  device(id: string) {
    const e = this.devices.get(id);
    if (!e)
      terminal(
        "device_expired",
        "This device-login attempt is no longer available.",
      );
    return {
      state: e.state,
      url: e.url,
      code: e.code,
      expiresAt: new Date(e.expires).toISOString(),
      deliveryId: e.deliveryId,
      message: e.message,
    };
  }
  cancelDevice(id: string) {
    const e = this.devices.get(id);
    if (e) {
      e.controller.abort();
      e.state = "cancelled";
    }
    return { cancelled: true };
  }
  async delivery(id: string) {
    const binding = await this.state.get(this.owner, `binding:${id}`);
    if (binding && binding.expires > Date.now()) return binding.value;
    const key = await this.state.get<{ id: string }>(
      this.authorization.owner,
      `delivery:${id}`,
    );
    if (key && key.expires > Date.now()) {
      const record = await this.state.get<KeyRecord>(
        this.authorization.owner,
        `key:${key.value.id}`,
      );
      if (record && !record.value.active && !record.value.revoked)
        return key.value;
    }
    terminal(
      "delivery_expired",
      "This protected setup bundle is unavailable. Existing secrets are never reconstructed automatically.",
    );
  }
  async acknowledge(id: string) {
    const binding = await this.state.get(this.owner, `binding:${id}`);
    if (binding) {
      await this.state.transaction(
        [],
        [{ owner: this.owner, id: `binding:${id}`, remove: true }],
      );
      return { acknowledged: true };
    }
    await this.authorization.acknowledge(id);
    return { acknowledged: true };
  }
  async disableConnection(id: string) {
    const policy = await this.authorization.policy(id);
    await this.authorization.savePolicy({ ...policy, enabled: false });
    return { disabled: true };
  }
  async updateConnection(value: unknown) {
    const p = record(value);
    if (
      Object.keys(p).some(
        (key) => !["id", "profiles", "allowedModels", "enabled"].includes(key),
      )
    )
      invalid("connection");
    if (
      (p.profiles !== undefined && !Array.isArray(p.profiles)) ||
      (p.allowedModels !== undefined && !Array.isArray(p.allowedModels)) ||
      (p.enabled !== undefined && typeof p.enabled !== "boolean")
    )
      invalid("connection");
    const entry = await this.state.get<ConnectionPolicy>(
      this.authorization.owner,
      `policy:${String(p.id)}`,
    );
    if (!entry)
      terminal("connection_missing", "This connection does not exist.");
    const policy = {
      ...entry.value,
      ...(p.profiles ? { profiles: p.profiles as string[] } : {}),
      ...(p.allowedModels
        ? { allowedModels: p.allowedModels as string[] }
        : {}),
      ...(typeof p.enabled === "boolean" ? { enabled: p.enabled } : {}),
    };
    if (
      policy.enabled &&
      policy.mode === "pool" &&
      !(await new ContextHandshake(this.state).qualified(
        policy.installationId!,
      ))
    )
      terminal(
        "context_handshake_required",
        "The matched n8n runtime must complete its lifecycle handshake before enabling this pool.",
      );
    for (const id of policy.profiles) await this.resources.store.readId(id);
    await this.authorization.savePolicy(policy);
    return {
      connection: policy,
      pinnedConversations: "Existing account pins are preserved.",
    };
  }
  async purgeHistory(id: string, activeRequests: number) {
    const entry = await this.state.get<ConnectionPolicy>(
      this.authorization.owner,
      `policy:${id}`,
    );
    if (!entry || entry.value.enabled || activeRequests)
      terminal(
        "drain_required",
        "Disable the connection and drain active gateway requests before deleting retained content.",
      );
    await this.state.purgeConnection(
      this.state.scope("history", id),
      this.state.scope("operations", id),
    );
    return {
      deleted: true,
      preserved: "Account pins and non-content operation fences",
      backupRetention:
        "Operator-managed backups follow their own sensitive-data retention policy.",
    };
  }
  async close(waitMs = 60000) {
    this.closing = true;
    for (const e of this.devices.values()) e.controller.abort();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.deviceStarts]).then(() =>
          Promise.allSettled([...this.deviceWork]),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Account connection shutdown did not settle; preserve the owner fence.",
                ),
              ),
            waitMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
