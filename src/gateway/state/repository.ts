import { Worker } from "node:worker_threads";
import { createHmac } from "node:crypto";
import path from "node:path";
import { mkdir, lstat, realpath } from "node:fs/promises";
import { WireError } from "../errors.js";

export interface Stored<T> {
  value: T;
  revision: number;
  created: number;
  touched: number;
  expires: number;
}
export interface StateWrite {
  owner: string;
  id: string;
  value?: unknown;
  expires?: number;
  remove?: boolean;
}
export interface StateCheck {
  owner: string;
  id: string;
  revision: number | null;
}
export class StateRepository {
  private worker?: Worker;
  private next = 0;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private failure?: Error;
  constructor(
    readonly filename: string,
    private readonly key: Buffer,
    readonly limits = { globalBytes: 1024 ** 3, ownerBytes: 256 * 1024 ** 2 },
    readonly retention = { idleDays: 30, absoluteDays: 90 },
  ) {}
  connectionCapacity(connection: string) {
    return this.call<boolean>("group", {
      group: this.scope("connection-capacity", connection),
      owners: [
        this.scope("history", connection),
        this.scope("operations", connection),
      ],
    });
  }
  scope(...parts: string[]): string {
    return createHmac("sha256", this.key)
      .update(JSON.stringify(["state-index-v1", ...parts]))
      .digest("hex");
  }
  digest(value: unknown): string {
    return createHmac("sha256", this.key)
      .update(JSON.stringify(["operation-body-v1", value]))
      .digest("hex");
  }
  async open(): Promise<void> {
    if (this.worker) throw new Error("Repository is already open.");
    const dir = path.dirname(this.filename);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await lstat(dir);
    if (
      !stat.isDirectory() ||
      stat.mode & 0o077 ||
      (await realpath(dir)) !== path.resolve(dir)
    )
      throw new Error("Gateway state requires a private real directory.");
    try {
      const file = await lstat(this.filename);
      if (!file.isFile() || file.isSymbolicLink() || file.mode & 0o077)
        throw new Error("Gateway state requires a private regular database.");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const worker = (this.worker = new Worker(
      path.join(__dirname, "worker.js"),
      {
        workerData: {
          filename: this.filename,
          key: this.key,
          ...this.limits,
          ...this.retention,
        },
      },
    ));
    await new Promise<void>((resolve, reject) => {
      worker.on("message", (m) => {
        if (m.ready) resolve();
        else {
          const p = this.pending.get(m.id);
          if (!p) return;
          this.pending.delete(m.id);
          if (m.error)
            p.reject(
              new WireError(
                m.error === "capacity" ? 503 : 422,
                m.error,
                m.error === "capacity"
                  ? "Gateway continuity capacity is exhausted; no request was admitted."
                  : "Gateway state could not be committed safely.",
              ),
            );
          else p.resolve(m.result);
        }
      });
      worker.on("error", () => {
        this.failure = new WireError(
          422,
          "storage",
          "Gateway persistence is unavailable.",
        );
        reject(this.failure);
        for (const p of this.pending.values()) p.reject(this.failure);
        this.pending.clear();
      });
      worker.on("exit", (code) => {
        if (code !== 0) {
          this.failure = new WireError(
            422,
            "storage",
            "Gateway persistence stopped unexpectedly.",
          );
          reject(this.failure);
          for (const p of this.pending.values()) p.reject(this.failure);
          this.pending.clear();
        }
      });
    });
  }
  private call<T>(action: string, args: unknown): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.worker)
      return Promise.reject(new Error("Repository is not open."));
    if (this.pending.size >= 256)
      return Promise.reject(
        new WireError(
          503,
          "capacity",
          "Persistence queue is full; no request was admitted.",
        ),
      );
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, action, args });
    });
  }
  get<T>(
    owner: string,
    key: string,
    bound?: { bytes: number; revision: number },
  ) {
    return this.call<Stored<T> | null>("get", { owner, key, bound });
  }
  metadata(owner: string, keys: string[]) {
    return this.call<
      Array<{ key: string; bytes: number; revision: number } | null>
    >("metadata", {
      owner,
      keys,
    });
  }
  touch(owner: string, keys: string[], idleMs: number, absoluteMs: number) {
    return this.call<boolean>("touch", { owner, keys, idleMs, absoluteMs });
  }
  list<T>(owner: string, limit = 256, prefix = "") {
    return this.call<Array<Stored<T> & { key: string }>>("list", {
      owner,
      limit,
      prefix,
    });
  }
  recent<T>(owner: string, limit = 100) {
    return this.call<Array<Stored<T> & { key: string }>>("list", {
      owner,
      limit,
      prefix: "",
      descending: true,
    });
  }
  transaction(
    checks: StateCheck[],
    writes: StateWrite[],
    release?: { owner: string; id: string },
  ) {
    return this.call<boolean>("transaction", { checks, writes, release });
  }
  reserve(
    owner: string,
    id: string,
    bytes: number,
    expires = Date.now() + 300000,
  ) {
    return this.call<boolean>("reserve", { owner, id, bytes, expires });
  }
  release(owner: string, id: string) {
    return this.call<boolean>("release", { owner, id });
  }
  cleanup(now = Date.now()) {
    return this.call<boolean>("cleanup", { now });
  }
  purgeConnection(historyOwner: string, operationsOwner: string) {
    return this.call<boolean>("purgeConnection", {
      historyOwner,
      operationsOwner,
    });
  }
  async close() {
    if (this.worker) {
      await this.call("close", {});
      this.worker = undefined;
    }
  }
}
