import { isProfileAccess, type ProfileBinding } from "../service/access.js";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, open, realpath, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { CodexError, assert, record } from "../core/errors.js";
import { delay } from "../core/http.js";
import { PROVIDER, type Profile } from "../core/types.js";
import { RotationStore } from "./rotation-store.js";

export function bindingHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
export const PROFILE_MAX_BYTES = 512 * 1024;
export function profileId(value: string): string {
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value),
    "The account profile identifier is invalid.",
  );
  return value;
}

/** One encrypted record contains both rotating tokens. Locks fail closed and are never stolen. */
export class ProfileStore {
  readonly rotation: RotationStore;
  private readonly key: Buffer;
  private readonly reads = new Map<string, Promise<Profile>>();
  constructor(
    readonly directory: string,
    key: Buffer,
    private readonly ensureOwner?: () => Promise<void>,
    readonly readOnly = false,
  ) {
    assert(path.isAbsolute(directory), "N8N_CODEX_STORE_DIR must be an absolute path.");
    assert(key.length === 32, "N8N_CODEX_STORE_KEY must be a base64-encoded 32-byte key.");
    this.key = Buffer.from(key);
    this.rotation = new RotationStore(this, key);
  }

  private async prepare(): Promise<void> {
    await this.ensureOwner?.();
    try {
      if (!this.readOnly) await mkdir(this.directory, { mode: 0o700, recursive: true });
      const stat = await lstat(this.directory);
      assert(
        stat.isDirectory() &&
          !stat.isSymbolicLink() &&
          (stat.mode & 0o077) === 0 &&
          (await realpath(this.directory)) === path.resolve(this.directory),
        "The account store must be a private directory with mode 0700 and no symbolic-link path components.",
      );
    } catch (error) {
      if (error instanceof CodexError) throw error;
      throw new CodexError(
        "storage",
        "The private account directory could not be opened. Check its location and permissions.",
      );
    }
  }

  private filename(id: string): string {
    return path.join(this.directory, `${profileId(id)}.json.enc`);
  }

  async ready(): Promise<void> {
    await this.prepare();
  }

  async exists(id: string): Promise<boolean> {
    await this.prepare();
    try {
      await lstat(this.filename(id));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new CodexError("storage", "The profile existence check failed.");
    }
  }

  async read(binding: ProfileBinding): Promise<Profile> {
    const profile = await this.readId(binding.profileId);
    if (isProfileAccess(binding)) return profile;
    const supplied = Buffer.from(bindingHash(binding.bindingSecret), "hex");
    const expected = Buffer.from(profile.bindingHash, "hex");
    assert(
      expected.length === supplied.length && timingSafeEqual(expected, supplied),
      "The account binding is invalid. Recreate the n8n credential from the profile binding file.",
    );
    return profile;
  }

  async readId(id: string): Promise<Profile> {
    profileId(id);
    let pending = this.reads.get(id);
    if (!pending) {
      pending = this.readRecord(id);
      this.reads.set(id, pending);
      const captured = pending;
      void pending
        .finally(() => {
          if (this.reads.get(id) === captured) this.reads.delete(id);
        })
        .catch(() => undefined);
    }
    return structuredClone(await pending);
  }

  private async readRecord(id: string): Promise<Profile> {
    await this.prepare();
    try {
      const file = this.filename(id);
      const envelope = record(JSON.parse(await readPrivateFile(file, 1024 * 1024)));
      assert(envelope.version === 1, "The account store format is unsupported.");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(String(envelope.iv), "base64"),
      );
      decipher.setAAD(Buffer.from(id));
      decipher.setAuthTag(Buffer.from(String(envelope.tag), "base64"));
      const text = Buffer.concat([
        decipher.update(Buffer.from(String(envelope.data), "base64")),
        decipher.final(),
      ]).toString("utf8");
      const profile = JSON.parse(text) as Profile;
      validateProfile(profile);
      assert(profile.id === id, "The account profile identity is invalid.");
      return profile;
    } catch (error) {
      if (error instanceof CodexError) throw error;
      throw new CodexError(
        "storage",
        "The account profile could not be read. Check its binding, store permissions, and encryption key.",
      );
    }
  }

  async write(profile: Profile): Promise<void> {
    assert(!this.readOnly, "This profile store is open for local read-only diagnostics.");
    profile = structuredClone(profile);
    this.reads.delete(profile.id);
    validateProfile(profile);
    assert(Buffer.byteLength(JSON.stringify(profile)) <= PROFILE_MAX_BYTES, "The account profile exceeds its bounded storage format.");
    await this.prepare();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(profile.id));
    const data = Buffer.concat([cipher.update(JSON.stringify(profile), "utf8"), cipher.final()]);
    await atomicWrite(
      this.filename(profile.id),
      JSON.stringify({
        version: 1,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      }),
    );
    this.reads.delete(profile.id);
  }

  /** A failed bootstrap renewal cannot replay an imported rotating secret after restart. */
  async claimImportRenewal(refreshToken: string): Promise<void> {
    assert(!this.readOnly, "This profile store is open for local read-only diagnostics.");
    await this.prepare();
    const fingerprint = createHmac("sha256", this.key).update(refreshToken).digest("hex");
    const filename = path.join(this.directory, `.import-${fingerprint}.used`);
    let handle;
    try {
      handle = await open(filename, "wx", 0o600);
      await handle.writeFile(
        "Bootstrap renewal claimed. Use fresh credentials after an uncertain outcome.\n",
      );
      await handle.sync();
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      throw new CodexError(
        "reconnect",
        "This imported rotating token was already used or could not be claimed safely. Use a fresh device login or independent token set.",
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async locked<T>(id: string, action: () => Promise<T>, timeoutMs = 30000): Promise<T> {
    assert(!this.readOnly, "This profile store is open for local read-only diagnostics.");
    await this.prepare();
    const lock = path.join(this.directory, `${profileId(id)}.lock`);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
          throw new CodexError("storage", "The account lock could not be acquired.");
        if (Date.now() >= deadline)
          throw new CodexError(
            "storage",
            "The account is locked by another operation. No refresh was attempted. Inspect abandoned locks only after stopping all users of the store.",
          );
        await delay(25 + Math.random() * 25);
      }
    }
    try {
      return await action();
    } finally {
      await rmdir(lock).catch(() => {
        throw new CodexError(
          "storage",
          "The account lock could not be released. Stop store users and inspect the lock before recovery.",
        );
      });
    }
  }
}

function validateProfile(profile: Profile): void {
  assert(
    profile &&
      profile.version === 1 &&
      profile.provider === PROVIDER &&
      Number.isSafeInteger(profile.generation) &&
      profile.generation > 0,
    "The account profile format is invalid.",
  );
  profileId(profile.id);
  if (profile.display !== undefined) {
    assert(
      profile.display && typeof profile.display === "object",
      "The profile display metadata is invalid.",
    );
    for (const [kind, metadata] of Object.entries(profile.display)) {
      assert(
        ["email", "plan"].includes(kind) &&
          metadata &&
          metadata.source === "verified_access_claim" &&
          typeof metadata.value === "string" &&
          metadata.value.length > 0 &&
          metadata.value.length <= (kind === "email" ? 254 : 64) &&
          !/[\x00-\x1f\x7f]/.test(metadata.value) &&
          Number.isFinite(metadata.verifiedAt),
        "The profile display metadata is invalid.",
      );
    }
  }

  assert(
    /^[a-f0-9]{64}$/.test(profile.bindingHash) &&
      ["ready", "reconnect", "refresh_uncertain"].includes(profile.state),
    "The account profile binding or state is invalid.",
  );
  assert(
    [profile.issuer, profile.subject, profile.accountId, profile.clientId, profile.label].every(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 512 &&
        !/[\x00-\x1f\x7f]/.test(value),
    ),
    "The account profile identity is invalid.",
  );
  assert(
    profile.tokens &&
      typeof profile.tokens.accessToken === "string" &&
      profile.tokens.accessToken.length > 0 &&
      profile.tokens.accessToken.length <= 65536,
    "The account token record is invalid.",
  );
  assert(
    [profile.tokens.refreshToken, profile.tokens.idToken].every(
      (value) =>
        value === undefined ||
        (typeof value === "string" && value.length > 0 && value.length <= 65536),
    ),
    "The account token record is invalid.",
  );
  assert(
    Number.isFinite(profile.tokens.expiresAt) &&
      profile.tokens.expiresAt >= 0 &&
      profile.tokens.expiresAt <= 8640000000000000 &&
      Number.isFinite(profile.verifiedAt) &&
      (profile.tokens.earliestRefreshAt === undefined ||
        Number.isFinite(profile.tokens.earliestRefreshAt)) &&
      Array.isArray(profile.tokens.scopes) &&
      profile.tokens.scopes.every((value) => typeof value === "string"),
    "The account token metadata is invalid.",
  );
}

/** Validate and read the same descriptor; never follow a swapped file symlink. */
export async function readPrivateFile(filename: string, maxBytes: number): Promise<string> {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    assert(
      stat.isFile() && (stat.mode & 0o077) === 0 && stat.size <= maxBytes,
      "The selected file must be private, regular, and within its size limit.",
    );
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(65536, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    assert(size <= maxBytes, "The selected file exceeds its size limit.");
    return Buffer.concat(chunks, size).toString("utf8");
  } catch (error) {
    if (error instanceof CodexError) throw error;
    throw new CodexError(
      "storage",
      "The protected file could not be opened. Check its location, permissions, and file type.",
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function atomicWrite(filename: string, data: string): Promise<void> {
  const temporary = `${filename}.${randomBytes(8).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
    const directory = await open(path.dirname(filename), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    throw new CodexError(
      "storage",
      "The account state could not be persisted atomically. Do not retry token rotation until the profile is recovered.",
    );
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
