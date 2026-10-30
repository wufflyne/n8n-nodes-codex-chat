import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { KeyRecord, ConnectionPolicy } from "./auth.js";
import type { StateRepository } from "./state/repository.js";
import { WireError } from "./errors.js";
const build: Record<string, unknown> = require("../integration/context-build.json");
export class ContextHandshake {
  private readonly owner: string;
  constructor(private readonly state: StateRepository) {
    this.owner = state.scope("context-handshakes");
  }
  async issue(key: KeyRecord, claim: unknown) {
    if (!key.scopes.includes("context:attest") || !key.installationId)
      throw new WireError(403, "context_scope", "This installation cannot attest model context.");
    if (!isDeepStrictEqual(claim, build))
      throw new WireError(
        422,
        "context_build_mismatch",
        "The matched lifecycle integration artifact and gateway build must agree.",
      );
    const id = randomBytes(24).toString("base64url"),
      expires = Date.now() + 3600000;
    const value = { keyId: key.id, installationId: key.installationId, artifact: build.artifact };
    await this.state.transaction(
      [],
      [
        { owner: this.owner, id: this.state.scope(id), value, expires },
        { owner: this.owner, id: `installation:${key.installationId}`, value, expires },
      ],
    );
    for (const connection of key.connections ?? []) {
      const owner = this.state.scope("authorization"),
        policy = await this.state.get<ConnectionPolicy>(owner, `policy:${connection}`);
      if (
        policy?.value.awaitingContext &&
        policy.value.installationId === key.installationId &&
        policy.value.mode === "pool"
      )
        await this.state.transaction(
          [{ owner, id: `policy:${connection}`, revision: policy.revision }],
          [
            {
              owner,
              id: `policy:${connection}`,
              value: { ...policy.value, enabled: true, awaitingContext: false },
              expires: Number.MAX_SAFE_INTEGER,
            },
          ],
        );
    }
    return { protocolVersion: 1, id, expires, artifact: build.artifact };
  }
  async qualified(installationId: string) {
    const entry = await this.state.get<{ keyId: string; artifact: string }>(
      this.owner,
      `installation:${installationId}`,
    );
    if (!entry || entry.expires <= Date.now() || entry.value.artifact !== build.artifact)
      return false;
    const key = await this.state.get<KeyRecord>(
      this.state.scope("authorization"),
      `key:${entry.value.keyId}`,
    );
    return key?.value.active === true;
  }
  async verify(key: KeyRecord, id: string | null) {
    if (!id || id.length > 100)
      throw new WireError(
        422,
        "context_handshake_required",
        "This pool requires the matched runtime lifecycle handshake.",
      );
    const entry = await this.state.get<{ keyId: string; installationId: string; artifact: string }>(
      this.owner,
      this.state.scope(id),
    );
    if (
      !entry ||
      entry.expires <= Date.now() ||
      entry.value.keyId !== key.id ||
      entry.value.installationId !== key.installationId ||
      entry.value.artifact !== build.artifact
    )
      throw new WireError(
        422,
        "context_handshake_required",
        "The runtime lifecycle handshake is missing, expired or belongs to a different installation.",
      );
  }
}
