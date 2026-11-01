import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, readPrivateFile } from "../auth/store.js";
import { assert, CodexError } from "../core/errors.js";

let pending = 0,
  tail: Promise<unknown> = Promise.resolve();
async function wrappingKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  assert(pending < 4, "Manager key setup is busy. Retry after the active setup finishes.");
  pending++;
  const flight = tail
    .catch(() => undefined)
    .then(
      () =>
        new Promise<Buffer>((resolve, reject) => {
          scrypt(
            passphrase,
            Buffer.concat([Buffer.from("codex-wire/native-wrap/v1\0"), salt]),
            32,
            { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
            (error, key) =>
              error
                ? reject(new CodexError("storage", "The bounded Manager key derivation failed."))
                : resolve(key),
          );
        }),
    );
  tail = flight;
  try {
    return await flight;
  } finally {
    pending--;
  }
}
/** Host-encrypted, user-chosen passphrase is durable before any dependent owner state. */
export async function nativeOwnerKey(
  directory: string,
  managerId: string,
  input: unknown,
): Promise<Buffer> {
  assert(
    typeof input === "string" && Array.from(input).length >= 12 && Buffer.byteLength(input) <= 1024,
    "Enter at least 12 characters (at most 1024 UTF-8 bytes) in the Manager passphrase field and save it. Keep this passphrase unchanged for this store.",
  );
  const file = path.join(directory, "manager-key-v1.enc");
  let exists = false;
  try {
    await lstat(file);
    exists = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const aad = Buffer.from(`codex-wire/native-owner-key/v1:${managerId}`);
  if (exists) {
    let derived: Buffer | undefined;
    try {
      const e = JSON.parse(await readPrivateFile(file, 4096));
      assert(
        e.version === 1 && e.managerId === managerId && e.kdf === "scrypt-32768-8-1",
        "The Manager key wrap identity or format is invalid.",
      );
      const salt = Buffer.from(e.salt, "base64"),
        iv = Buffer.from(e.iv, "base64"),
        tag = Buffer.from(e.tag, "base64"),
        data = Buffer.from(e.data, "base64");
      assert(
        salt.length === 32 && iv.length === 12 && tag.length === 16 && data.length === 32,
        "The Manager key wrap is invalid.",
      );
      derived = await wrappingKey(input, salt);
      const cipher = createDecipheriv("aes-256-gcm", derived, iv);
      cipher.setAAD(aad);
      cipher.setAuthTag(tag);
      const key = Buffer.concat([cipher.update(data), cipher.final()]);
      assert(key.length === 32, "The Manager owner key is invalid.");
      return key;
    } catch {
      throw new CodexError(
        "storage",
        "The Manager passphrase does not unlock its established key wrap. Restore the original credential/passphrase; this action never replaces or rotates that key.",
      );
    } finally {
      derived?.fill(0);
    }
  }
  const names = await readdir(directory);
  assert(
    !names.some(
      (n) =>
        n === "manager.json" ||
        n.endsWith(".enc") ||
        n === "resets" ||
        n === ".rotation-v2.initialized",
    ),
    "This established store has no recoverable Manager key wrap. Preserve its current credential and state; a new passphrase cannot create a replacement root.",
  );
  const salt = randomBytes(32),
    iv = randomBytes(12),
    key = randomBytes(32),
    derived = await wrappingKey(input, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", derived, iv);
    cipher.setAAD(aad);
    const data = Buffer.concat([cipher.update(key), cipher.final()]);
    await atomicWrite(
      file,
      JSON.stringify({
        version: 1,
        managerId,
        kdf: "scrypt-32768-8-1",
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      }),
    );
    return key;
  } finally {
    derived.fill(0);
  }
}
