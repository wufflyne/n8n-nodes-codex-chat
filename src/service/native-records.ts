import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, readPrivateFile } from "../auth/store.js";
import { assert, CodexError } from "../core/errors.js";
import type { Binding } from "../core/types.js";
import type { OwnerLock } from "./native-locks.js";
export interface NativeAccount {
  binding: Binding;
  deliveryId: string;
  acknowledged: boolean;
  established?: boolean;
  attempt?: {
    id: string;
    state:
      | "starting"
      | "waiting"
      | "polling"
      | "exchanging"
      | "captured"
      | "connected"
      | "cancelled"
      | "expired"
      | "uncertain";
    deviceId?: string;
    userCode?: string;
    expiresAt?: number;
    nextPollAt?: number;
    interval?: number;
    capture?: string;
    reconnect: boolean;
  };
  importReceipt?: { digest: string; state: "prepared" | "connected" };
  retiredAttempts?: Array<NonNullable<NativeAccount["attempt"]>>;
}
export interface NativeState {
  version: 1;
  managerId: string;
  accounts: Record<string, NativeAccount>;
}
const terminal = (state: string) => ["connected", "cancelled", "expired"].includes(state);
/** Ordinary successful reconnects retain bounded metadata; uncertainty is never discarded. */
export function retireConnectionAttempt(account: NativeAccount) {
  if (!account.attempt) return;
  const previous = account.attempt;
  const retained = account.retiredAttempts ?? [];
  const unresolved = retained.filter((a) => !terminal(a.state));
  const recent = retained.filter((a) => terminal(a.state)).slice(-15);
  if (terminal(previous.state))
    recent.push({
      id: previous.id,
      state: previous.state,
      reconnect: previous.reconnect,
      expiresAt: previous.expiresAt,
    });
  else {
    assert(
      unresolved.length < 32,
      "This account has 32 unresolved sign-in attempts. Their fences are preserved. Create a separate Account credential for an independent sign-in and use separate conversation memory; this action cannot discard or retry an unknown exchange.",
    );
    unresolved.push(structuredClone(previous));
  }
  account.retiredAttempts = [...unresolved, ...recent.slice(-16)];
}
/** Provider secrets follow the saved passphrase, authenticated key wrap and target ACK. */
export class NativeRecords {
  private readonly key: Buffer;
  private readonly file: string;
  constructor(
    readonly managerId: string,
    directory: string,
    key: Buffer,
    private readonly lock: OwnerLock,
  ) {
    this.key = createHmac("sha256", key).update("codex-wire/native-connections/v1").digest();
    this.file = path.join(directory, ".native-connections-v1.json.enc");
  }
  async read(): Promise<NativeState> {
    try {
      await lstat(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await lstat(this.file + ".initialized");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
          return { version: 1, managerId: this.managerId, accounts: {} };
        throw e;
      }
      throw new CodexError(
        "storage",
        "The established native connection journal is missing. Preserve current state; do not issue new bindings or sign-in requests.",
      );
    }
    try {
      const e = JSON.parse(await readPrivateFile(this.file, 12 * 1024 * 1024));
      assert(e.version === 1, "The native connection journal format is unsupported.");
      const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(e.iv, "base64"));
      d.setAAD(Buffer.from(this.managerId));
      d.setAuthTag(Buffer.from(e.tag, "base64"));
      const state = JSON.parse(
        Buffer.concat([d.update(Buffer.from(e.data, "base64")), d.final()]).toString("utf8"),
      ) as NativeState;
      assert(
        state.version === 1 &&
          state.managerId === this.managerId &&
          state.accounts &&
          Object.keys(state.accounts).length <= 128,
        "The native connection journal identity or bounds are invalid.",
      );
      for (const account of Object.values(state.accounts)) {
        if (
          account.attempt?.state === "connected" ||
          account.importReceipt?.state === "connected" ||
          account.retiredAttempts?.some((a) => a.state === "connected")
        )
          account.established = true;
      }
      return state;
    } catch (error) {
      if (error instanceof CodexError) throw error;
      throw new CodexError(
        "storage",
        "The native connection journal cannot be authenticated. Preserve it and its current Manager credential.",
      );
    }
  }
  async update<T>(action: (state: NativeState) => T): Promise<T> {
    return this.lock("native-records", async () => {
      const state = await this.read(),
        result = action(state),
        text = JSON.stringify(state);
      assert(
        Object.keys(state.accounts).length <= 128 && Buffer.byteLength(text) <= 8 * 1024 * 1024,
        "The bounded native connection store is full.",
      );
      const iv = randomBytes(12),
        c = createCipheriv("aes-256-gcm", this.key, iv);
      c.setAAD(Buffer.from(this.managerId));
      const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
      await atomicWrite(
        this.file,
        JSON.stringify({
          version: 1,
          iv: iv.toString("base64"),
          tag: c.getAuthTag().toString("base64"),
          data: data.toString("base64"),
        }),
      );
      await atomicWrite(this.file + ".initialized", "codex-wire/native-connections/v1\n");
      return result;
    });
  }
}
