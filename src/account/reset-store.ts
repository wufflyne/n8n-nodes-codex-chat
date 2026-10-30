import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import { mkdir, lstat, realpath, rmdir, readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, readPrivateFile } from "../auth/store.js";
import { assert, CodexError } from "../core/errors.js";
import { delay, throwIfAborted } from "../core/http.js";
import type { Identity } from "../core/types.js";
import type { ResetOutcome } from "./types.js";
export interface ResetIntent {
  redeemRequestId: string;
  creditId: string;
  actor: string;
  profileId: string;
  executionKey: string;
  origin: "manual" | "automatic";
  policyHash: string;
  trigger: string;
  attemptExecutions?: string[];
  createdAt: number;
  lastAttemptAt: number | null;
  dispatchCount: number;
  state:
    | "prepared"
    | "cancelled_before_send"
    | "dispatching"
    | "uncertain"
    | "terminal";
  outcome: ResetOutcome | null;
  windowsReset: number | null;
}
export interface ResetLedger {
  schemaVersion: 1;
  revision: number;
  accountScope: string;
  actions: ResetIntent[];
}
export interface Reservation {
  version: 1;
  revision: number;
  accountScope: string;
  redeemRequestId: string;
  state: "reserved" | "dispatched" | "terminal" | "cancelled_before_send";
}
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const actorFingerprint = (identity: Identity) =>
  hash([
    identity.issuer,
    identity.clientId,
    identity.accountId,
    identity.subject,
  ]);
export class ResetStore {
  readonly directory: string;
  private readonly key: Buffer;
  private readonly scopeKey: Buffer;
  constructor(directory: string, master: Buffer) {
    this.directory = path.join(directory, "resets");
    assert(master.length === 32, "The reset store key is invalid.");
    this.key = createHmac("sha256", master)
      .update("codex-reset-encryption-v1")
      .digest();
    this.scopeKey = createHmac("sha256", master)
      .update("codex-reset-scope-v1")
      .digest();
  }
  scope(identity: Identity): string {
    return createHmac("sha256", this.scopeKey)
      .update(
        JSON.stringify([
          identity.issuer,
          identity.clientId,
          identity.accountId,
        ]),
      )
      .digest("hex");
  }
  private async prepare() {
    for (const directory of [
      path.dirname(this.directory),
      this.directory,
      path.join(this.directory, "executions"),
    ]) {
      await mkdir(directory, { mode: 0o700, recursive: true });
      const stat = await lstat(directory);
      assert(
        stat.isDirectory() &&
          !stat.isSymbolicLink() &&
          (stat.mode & 0o077) === 0 &&
          (await realpath(directory)) === directory,
        "The reset store must be private with no symbolic links.",
      );
    }
  }
  private id(value: string) {
    assert(
      /^[a-f0-9]{64}$/.test(value),
      "The reset journal identifier is invalid.",
    );
    return value;
  }
  async accountLock<T>(
    scope: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ) {
    return this.lock(this.id(scope), action, signal);
  }
  private async lock<T>(
    name: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.prepare();
    const filename = path.join(this.directory, `${name}.lock`),
      deadline = Date.now() + 10000;
    while (true) {
      throwIfAborted(signal);
      try {
        await mkdir(filename, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
          throw new CodexError(
            "storage",
            "The reset journal lock could not be acquired.",
          );
        if (Date.now() >= deadline)
          throw new CodexError(
            "storage",
            "The reset journal is locked. Stop all store users before inspecting abandoned locks.",
          );
        await delay(30, signal);
      }
    }
    try {
      throwIfAborted(signal);
      return await action();
    } finally {
      await rmdir(filename).catch(() => {
        throw new CodexError(
          "storage",
          "The reset journal lock could not be released. Stop store users before recovery.",
        );
      });
    }
  }
  private async read<T>(file: string, aad: string): Promise<T | undefined> {
    await this.prepare();
    try {
      await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new CodexError(
        "storage",
        "The reset journal could not be inspected.",
      );
    }
    try {
      const e = JSON.parse(await readPrivateFile(file, 1024 * 1024));
      assert(e.version === 1, "The reset journal version is unsupported.");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(e.iv, "base64"),
      );
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(Buffer.from(e.tag, "base64"));
      return JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(e.data, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      ) as T;
    } catch {
      throw new CodexError(
        "storage",
        "The encrypted reset journal is invalid or cannot be read. Reset actions remain blocked.",
      );
    }
  }
  private async write(file: string, aad: string, value: unknown) {
    await this.prepare();
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    await atomicWrite(
      file,
      JSON.stringify({
        version: 1,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: bytes.toString("base64"),
      }),
    );
  }
  async ledger(scope: string): Promise<ResetLedger> {
    scope = this.id(scope);
    const value = await this.read<ResetLedger>(
      path.join(this.directory, `${scope}.json.enc`),
      `codex-reset-ledger:v1:${scope}`,
    );
    if (!value)
      return {
        schemaVersion: 1,
        revision: 0,
        accountScope: scope,
        actions: [],
      };
    assert(
      value.schemaVersion === 1 &&
        value.accountScope === scope &&
        Number.isSafeInteger(value.revision) &&
        Array.isArray(value.actions) &&
        value.actions.length <= 256,
      "The reset ledger format is invalid.",
    );
    for (const a of value.actions)
      assert(
        typeof a.redeemRequestId === "string" &&
          /^[a-f0-9-]{36}$/.test(a.redeemRequestId) &&
          typeof a.creditId === "string" &&
          a.creditId.length <= 256 &&
          /^[a-f0-9]{64}$/.test(a.actor) &&
          /^[a-f0-9]{64}$/.test(a.executionKey) &&
          Number.isSafeInteger(a.dispatchCount) &&
          a.dispatchCount >= 0 &&
          a.dispatchCount <= 3 &&
          Number.isFinite(a.createdAt) &&
          [
            "prepared",
            "cancelled_before_send",
            "dispatching",
            "uncertain",
            "terminal",
          ].includes(a.state),
        "The reset intent format is invalid.",
      );
    return structuredClone(value);
  }
  async writeLedger(ledger: ResetLedger) {
    assert(
      ledger.actions.length <= 256,
      "The reset journal is full. Ordinary inference is still available.",
    );
    ledger.revision++;
    await this.write(
      path.join(this.directory, `${this.id(ledger.accountScope)}.json.enc`),
      `codex-reset-ledger:v1:${ledger.accountScope}`,
      ledger,
    );
  }
  private reservationPath(key: string) {
    return path.join(this.directory, "executions", `${this.id(key)}.json.enc`);
  }
  async reservation(key: string): Promise<Reservation | undefined> {
    const r = await this.read<Reservation>(
      this.reservationPath(key),
      `codex-reset-execution:v1:${key}`,
    );
    if (r)
      assert(
        r.version === 1 &&
          Number.isSafeInteger(r.revision) &&
          /^[a-f0-9]{64}$/.test(r.accountScope) &&
          [
            "reserved",
            "dispatched",
            "terminal",
            "cancelled_before_send",
          ].includes(r.state),
        "The reset execution reservation is invalid.",
      );
    return r;
  }
  async reservationsFor(
    scope: string,
  ): Promise<Array<{ key: string; value: Reservation }>> {
    await this.prepare();
    const files = await readdir(path.join(this.directory, "executions"));
    assert(
      files.length <= 8192,
      "The reset execution reservation store exceeds its supported bound.",
    );
    const result: Array<{ key: string; value: Reservation }> = [];
    for (const file of files) {
      const match = /^([a-f0-9]{64})\.json\.enc$/.exec(file);
      if (!match) continue;
      const value = await this.reservation(match[1]!);
      if (value?.accountScope === scope && value.state === "reserved")
        result.push({ key: match[1]!, value });
    }
    return result;
  }
  async hasLedger(scope: string) {
    await this.prepare();
    try {
      const stat = await lstat(
        path.join(this.directory, `${this.id(scope)}.json.enc`),
      );
      return stat.isFile() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  }
  async reserve(key: string, scope: string, id: string): Promise<boolean> {
    return this.lock("coordination", async () => {
      const current = await this.reservation(key);
      if (current && current.state !== "cancelled_before_send") return false;
      const files = await readdir(path.join(this.directory, "executions"));
      assert(
        files.length < 8192 || current,
        "The durable reset reservation store is full. Reset actions are blocked until operator maintenance.",
      );
      await this.write(
        this.reservationPath(key),
        `codex-reset-execution:v1:${key}`,
        {
          version: 1,
          revision: (current?.revision ?? 0) + 1,
          accountScope: this.id(scope),
          redeemRequestId: id,
          state: "reserved",
        } satisfies Reservation,
      );
      return true;
    });
  }
  /** Call only after releasing the account action lock; account state is the dispatch authority. */
  async updateReservation(
    key: string,
    scope: string,
    id: string,
    state: Reservation["state"],
  ) {
    await this.lock("coordination", async () => {
      const current = await this.reservation(key);
      assert(
        current &&
          current.accountScope === scope &&
          current.redeemRequestId === id,
        "The reset execution reservation does not match its durable intent.",
      );
      await this.write(
        this.reservationPath(key),
        `codex-reset-execution:v1:${key}`,
        { ...current, revision: current.revision + 1, state },
      );
    });
  }
}
