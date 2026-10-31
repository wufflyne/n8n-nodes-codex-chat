import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { assert } from "../core/errors.js";

const CHUNK_BYTES = 64 * 1024;
const AAD = Buffer.from("codex-wire/rotation/v2");

/** The same bounded serialization drives admission and encrypted persistence. */
export function* journalChunks(journal: { version: 2; migrated: true; claims: object; receipts: object; registrations: object }): Generator<string> {
  yield '{"version":2,"migrated":true';
  for (const name of ["claims", "receipts", "registrations"] as const) {
    yield `,${JSON.stringify(name)}:{`;
    let first = true;
    for (const [key, value] of Object.entries(journal[name])) {
      yield `${first ? "" : ","}${JSON.stringify(key)}:`;
      const text = JSON.stringify(value);
      // Do not split a UTF-16 surrogate pair between UTF-8 cipher updates.
      for (let begin = 0; begin < text.length;) {
        let end = Math.min(begin + CHUNK_BYTES, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
        yield text.slice(begin, end); begin = end;
      }
      first = false;
    }
    yield "}";
  }
  yield "}";
}

/** Read the existing canonical v2 envelope without retaining its base64 copy. */
export async function readJournal(filename: string, key: Buffer, maxBytes: number): Promise<unknown> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    assert(before.isFile() && (before.mode & 0o077n) === 0n && before.size <= BigInt(Math.ceil(maxBytes / 3) * 4 + 1024), "The token journal must be a bounded private regular file.");
    const prefix = Buffer.alloc(256);
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
    const header = /^\{"version":2,"iv":"([A-Za-z0-9+/]{16})","tag":"([A-Za-z0-9+/]{22}==)","data":"/.exec(prefix.subarray(0, bytesRead).toString("latin1"));
    assert(header, "The token journal envelope is invalid or unsupported.");
    const end = Number(before.size) - 2, suffix = Buffer.alloc(2);
    assert(end >= header[0].length && (end - header[0].length) % 4 === 0, "The token journal envelope is truncated.");
    assert((await file.read(suffix, 0, 2, end)).bytesRead === 2 && suffix.toString() === '"}', "The token journal envelope is truncated.");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header[1]!, "base64"));
    decipher.setAAD(AAD); decipher.setAuthTag(Buffer.from(header[2]!, "base64"));
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const pieces: string[] = [];
    let size = 0;
    const consume = (bytes: Buffer) => {
      size += bytes.length;
      assert(size <= maxBytes, "The token journal exceeds its payload limit.");
      pieces.push(decoder.decode(bytes, { stream: true }));
    };
    const buffer = Buffer.alloc(CHUNK_BYTES);
    for (let position = header[0].length; position < end;) {
      const length = Math.min(buffer.length, end - position);
      const read = await file.read(buffer, 0, length, position);
      assert(read.bytesRead === length, "The token journal changed or was truncated while reading.");
      const encoded = buffer.subarray(0, length).toString("latin1");
      assert((position + length === end ? /^[A-Za-z0-9+/]*={0,2}$/ : /^[A-Za-z0-9+/]*$/).test(encoded), "The token journal encoding is invalid.");
      const bytes = Buffer.from(encoded, "base64");
      assert(bytes.toString("base64") === encoded, "The token journal encoding is not canonical.");
      consume(decipher.update(bytes)); position += length;
    }
    // Never parse or use unauthenticated plaintext, including after partial reads.
    consume(decipher.final()); pieces.push(decoder.decode());
    const after = await file.stat({ bigint: true });
    assert(before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, "The token journal changed while reading.");
    const text = pieces.join(""); pieces.length = 0;
    return JSON.parse(text);
  } finally { await file.close(); }
}

/** Only encrypted bytes enter the sibling; the GCM tag is completed before sync. */
export async function writeJournal(filename: string, key: Buffer, chunks: Iterable<string>): Promise<void> {
  const temporary = `${filename}.${randomBytes(8).toString("hex")}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    const prefix = `{"version":2,"iv":"${iv.toString("base64")}","tag":"`;
    const header = prefix + "0".repeat(24) + '","data":"';
    await file.writeFile(header);
    for (const text of chunks) {
      const encrypted = cipher.update(text, "utf8", "base64");
      if (encrypted) await file.writeFile(encrypted);
    }
    await file.writeFile(cipher.final("base64") + '"}');
    const tag = cipher.getAuthTag().toString("base64");
    assert((await file.write(tag, Buffer.byteLength(prefix), "ascii")).bytesWritten === tag.length, "The token journal authentication tag could not be written.");
    await file.sync(); await file.close(); file = undefined;
    await rename(temporary, filename);
    const directory = await open(path.dirname(filename), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
