import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { StateRepository } from "./state/repository.js";
import { WireError, terminal } from "./errors.js";

export type KeyRole = "inference" | "installation" | "administrator";
export interface KeyRecord {
  id: string;
  verifier: string;
  role: KeyRole;
  scopes: string[];
  active: boolean;
  revoked?: boolean;
  installationId?: string;
  connectionId?: string;
  profiles?: string[];
  connections?: string[];
}
export interface ConnectionPolicy {
  id: string;
  name: string;
  mode: "fixed" | "pool";
  profiles: string[];
  allowedModels: string[];
  installationId?: string;
  localContinuityConsent: boolean;
  enabled: boolean;
  contextQualified?: boolean;
  awaitingContext?: boolean;
}
const verifier = (key: string) => createHash("sha256").update(key).digest("hex");
export class GatewayAuthorization {
  readonly owner: string;
  constructor(private readonly state: StateRepository) {
    this.owner = state.scope("authorization");
  }
  async prepareKey(
    record: Omit<KeyRecord, "id" | "verifier" | "active">,
    deliveryId = randomUUID(),
  ) {
    const pending = await this.state.get<{ key: string; id: string }>(
      this.owner,
      `delivery:${deliveryId}`,
    );
    if (pending && pending.expires > Date.now()) return { ...pending.value, deliveryId };
    if ((await this.state.list(this.owner, 256, "key:")).length >= 256)
      throw new WireError(
        422,
        "key_capacity",
        "This installation has reached its bounded 256-key registry capacity.",
      );
    const id = randomBytes(9).toString("base64url"),
      key = `cw_${id}.${randomBytes(32).toString("base64url")}`;
    await this.state.transaction(
      [{ owner: this.owner, id: `delivery:${deliveryId}`, revision: pending?.revision ?? null }],
      [
        {
          owner: this.owner,
          id: `key:${id}`,
          value: { ...record, id, verifier: verifier(key), active: false },
          expires: Number.MAX_SAFE_INTEGER,
        },
        {
          owner: this.owner,
          id: `delivery:${deliveryId}`,
          value: { key, id },
          expires: Date.now() + 3600000,
        },
      ],
    );
    return { key, id, deliveryId };
  }
  async acknowledge(deliveryId: string) {
    const pending = await this.state.get<{ key: string; id: string }>(
      this.owner,
      `delivery:${deliveryId}`,
    );
    if (!pending || pending.expires <= Date.now())
      terminal(
        "delivery_expired",
        "This setup bundle has expired. Request a deliberate replacement.",
      );
    const entry = await this.state.get<KeyRecord>(this.owner, `key:${pending.value.id}`);
    if (!entry) terminal("delivery_missing", "The pending key record is unavailable.");
    if (entry.value.revoked)
      terminal("key_revoked", "This key was revoked and cannot be activated.");
    await this.state.transaction(
      [{ owner: this.owner, id: `key:${entry.value.id}`, revision: entry.revision }],
      [
        {
          owner: this.owner,
          id: `key:${entry.value.id}`,
          value: { ...entry.value, active: true },
          expires: Number.MAX_SAFE_INTEGER,
        },
        { owner: this.owner, id: `delivery:${deliveryId}`, remove: true },
      ],
    );
  }
  async authenticate(key: string, role: KeyRole): Promise<KeyRecord> {
    const match = /^cw_([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{43})$/.exec(key);
    const entry = match ? await this.state.get<KeyRecord>(this.owner, `key:${match[1]}`) : null;
    const supplied = Buffer.from(verifier(key), "hex"),
      expected = Buffer.from(entry?.value.verifier ?? "0".repeat(64), "hex");
    if (!entry || !entry.value.active || !timingSafeEqual(supplied, expected))
      throw new WireError(401, "invalid_key", "The gateway key is invalid or inactive.");
    if (entry.value.role !== role)
      throw new WireError(403, "wrong_scope", "This gateway key cannot access this service.");
    return entry.value;
  }
  async policy(id: string): Promise<ConnectionPolicy> {
    const entry = await this.state.get<ConnectionPolicy>(this.owner, `policy:${id}`);
    if (!entry?.value.enabled)
      throw new WireError(403, "connection_disabled", "This inference connection is disabled.");
    return entry.value;
  }
  async savePolicy(policy: ConnectionPolicy) {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(policy.id) ||
      !policy.name ||
      policy.name.length > 80 ||
      !["fixed", "pool"].includes(policy.mode) ||
      !Array.isArray(policy.profiles) ||
      policy.profiles.length < 1 ||
      policy.profiles.length > 128 ||
      new Set(policy.profiles).size !== policy.profiles.length ||
      (policy.mode === "fixed" && policy.profiles.length !== 1) ||
      !Array.isArray(policy.allowedModels) ||
      policy.allowedModels.some((m) => typeof m !== "string" || m.length > 200)
    )
      throw new WireError(400, "invalid_policy", "The connection policy is invalid.");
    if (!policy.localContinuityConsent)
      throw new WireError(
        400,
        "retention_consent_required",
        "Acknowledge encrypted local history retention before creating this connection.",
      );
    if (policy.mode === "pool" && (!policy.contextQualified || !policy.installationId))
      throw new WireError(
        422,
        "context_required",
        "Pool connections require a qualified Model Request Context v1 installation.",
      );
    await this.state.transaction(
      [],
      [
        {
          owner: this.owner,
          id: `policy:${policy.id}`,
          value: policy,
          expires: Number.MAX_SAFE_INTEGER,
        },
      ],
    );
  }
  async revoke(id: string) {
    const entry = await this.state.get<KeyRecord>(this.owner, `key:${id}`);
    if (entry)
      await this.state.transaction(
        [{ owner: this.owner, id: `key:${id}`, revision: entry.revision }],
        [
          {
            owner: this.owner,
            id: `key:${id}`,
            value: { ...entry.value, active: false, revoked: true },
            expires: Number.MAX_SAFE_INTEGER,
          },
        ],
      );
  }
}
