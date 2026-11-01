import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { lstat, readdir } from "node:fs/promises";
import { assert } from "../core/errors.js";
import { atomicWrite, readPrivateFile } from "../auth/store.js";
import { createResources } from "./resources.js";
import { EmbeddedService } from "./embedded.js";
import { persistCredential, type CredentialContext } from "./credential-persistence.js";
import { NativeOwner } from "./native-owner.js";
import { nativeLocks } from "./native-locks.js";
import { NativeRecords } from "./native-records.js";
import type { CodexService } from "./contracts.js";
import { nativeOwnerKey } from "./native-key.js";
import { ManagedService } from "./managed.js";

const managers = new Map<string, NativeManager>();
export function nativeStoreRoot() {
  return path.join(
    process.env.N8N_USER_FOLDER ?? process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(),
    ".n8n",
    "codex-wire",
  );
}
export class NativeManager {
  readonly resources: ReturnType<typeof createResources>;
  readonly service: CodexService;
  readonly records: NativeRecords;
  readonly lock = nativeLocks();
  private closing = false;
  private readonly active = new Set<Promise<unknown>>();
  private readonly passphraseVerifier: Buffer;
  constructor(
    readonly id: string,
    readonly owner: NativeOwner,
    readonly key: Buffer,
    passphrase: string,
    private readonly instanceOwner?: NativeOwner,
  ) {
    this.passphraseVerifier = createHmac("sha256", key)
      .update("native-manager-authority/v1\0")
      .update(passphrase)
      .digest();
    this.resources = createResources(owner.directory, key, true, this.lock);
    this.records = new NativeRecords(id, owner.directory, key, this.lock);
    this.service = new ManagedService(new EmbeddedService(this.resources), this);
  }
  authorize(passphrase: unknown, cachedKey: unknown) {
    assert(
      typeof passphrase === "string" && Buffer.byteLength(passphrase) <= 1024,
      "Select the original saved Manager credential.",
    );
    const supplied = createHmac("sha256", this.key)
      .update("native-manager-authority/v1\0")
      .update(passphrase)
      .digest();
    assert(
      timingSafeEqual(supplied, this.passphraseVerifier) &&
        (!cachedKey || cachedKey === this.key.toString("base64")),
      "The Manager credential no longer matches its active service. Restore the original passphrase; changing it does not rotate this store.",
    );
  }
  private admit(promise: Promise<unknown>) {
    assert(
      !this.closing && this.active.size < 512,
      "Codex Wire Service is stopping or busy. Retry after its active operations finish.",
    );
    this.active.add(promise);
    void promise.finally(() => this.active.delete(promise)).catch(() => undefined);
  }
  ensureOpen() {
    assert(!this.closing, "Codex Wire Service is stopping. No new connection request was sent.");
  }
  async run<T>(action: () => Promise<T>) {
    assert(!this.closing && this.active.size < 512, "Codex Wire Service is stopping or busy.");
    const promise = Promise.resolve().then(action);
    this.admit(promise);
    return promise;
  }
  async *stream<T>(action: () => AsyncGenerator<T>) {
    let release!: () => void;
    const fence = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.admit(fence);
    try {
      yield* action();
    } finally {
      release();
    }
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.active]);
    await this.resources.sessions.settleRenewals();
    await Promise.allSettled([
      this.resources.catalog.settleReads(),
      this.resources.account.settleReads(),
    ]);
    managers.delete(this.id);
    this.owner.close();
    this.instanceOwner?.close();
  }
}
export function managerById(id: string) {
  const m = managers.get(id);
  assert(m, "Activate the Codex Wire Service workflow for this Manager first.");
  return m;
}

export async function startNativeManager(ctx: CredentialContext) {
  assert(
    process.env.EXECUTIONS_MODE !== "queue",
    "Codex Wire native service currently requires one local n8n execution process.",
  );
  const { authorizedCredential } = await import("./credential-persistence.js");
  const selected = await authorizedCredential(ctx, "codexWireManager");
  assert(
    !managers.has(selected.id),
    "This Manager already has an active Codex Wire Service workflow.",
  );
  const instanceOwner = new NativeOwner(nativeStoreRoot());
  await instanceOwner.acquire();
  const owner = new NativeOwner(
    path.join(nativeStoreRoot(), createHash("sha256").update(selected.id).digest("hex")),
  );
  try {
    const instanceFile = path.join(nativeStoreRoot(), "instance-manager.json");
    let claimed = false;
    try {
      await lstat(instanceFile);
      claimed = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (claimed) {
      const claim = JSON.parse(await readPrivateFile(instanceFile, 2048));
      assert(
        claim.version === 1 && claim.managerId === selected.id,
        "This n8n instance belongs to its original Codex Wire Manager. Select that credential; a second Manager cannot create another token-family journal.",
      );
    } else {
      for (const child of await readdir(nativeStoreRoot())) {
        if (!/^[a-f0-9]{64}$/.test(child)) continue;
        const names = await readdir(path.join(nativeStoreRoot(), child));
        assert(
          child === createHash("sha256").update(selected.id).digest("hex") ||
            !names.some((n) => n === "manager.json" || n === "manager-key-v1.enc"),
          "The instance Manager claim is missing beside another Manager key wrap or manifest. Preserve the original Manager credential and store; setup cannot select a replacement owner.",
        );
        assert(
          !names.some(
            (n) =>
              n === ".native-connections-v1.json.enc.initialized" ||
              n === ".rotation-v2.initialized" ||
              n === "resets",
          ),
          "The established instance Manager claim is missing. Preserve every current store; setup cannot create a replacement ownership claim.",
        );
      }
    }
    await owner.acquire();
    const file = path.join(owner.directory, "manager.json");
    let manifest: { version: number; managerId: string; keyHash: string } | undefined;
    try {
      await lstat(file);
      manifest = JSON.parse(await readPrivateFile(file, 2048));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const fresh = await authorizedCredential(ctx, "codexWireManager");
    assert(fresh.id === selected.id, "The selected Manager changed during activation.");
    const key = await nativeOwnerKey(owner.directory, fresh.id, fresh.data.managerPassphrase),
      encoded = key.toString("base64");
    const saved = await persistCredential(ctx, "codexWireManager", async (id, current) => {
      assert(
        current.managerPassphrase === fresh.data.managerPassphrase,
        "The Manager credential changed during setup. Retry with the original saved passphrase.",
      );
      assert(
        !current.ownerKey || current.ownerKey === encoded,
        "The cached Manager key differs from its authenticated wrap. Preserve current state.",
      );
      assert(
        !manifest ||
          (manifest.version === 3 &&
            manifest.managerId === id &&
            manifest.keyHash === createHash("sha256").update(encoded).digest("hex")),
        "The Manager credential does not match its established store.",
      );
      return { ownerKey: encoded };
    });
    if (!manifest)
      await atomicWrite(
        file,
        JSON.stringify({
          version: 3,
          managerId: saved.id,
          keyHash: createHash("sha256").update(String(saved.data.ownerKey)).digest("hex"),
        }),
      );
    if (!claimed)
      await atomicWrite(instanceFile, JSON.stringify({ version: 1, managerId: saved.id }));
    const manager = new NativeManager(
      saved.id,
      owner,
      key,
      String(fresh.data.managerPassphrase),
      instanceOwner,
    );
    managers.set(saved.id, manager);
    return manager;
  } catch (error) {
    owner.close();
    instanceOwner.close();
    throw error;
  }
}
