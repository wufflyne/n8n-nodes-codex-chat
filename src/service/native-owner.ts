import { DatabaseSync } from "node:sqlite";
import { constants } from "node:fs";
import { mkdir, lstat, realpath, open, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { assert, CodexError } from "../core/errors.js";
import { atomicWrite, readPrivateFile } from "../auth/store.js";

const BARRIER = '{"format":"codex-wire-native-owner","version":3,"minimumOwnerVersion":"0.1.1"}';
/** An exclusive rollback-journal transaction is released by the OS on process death. */
export class NativeOwner {
  private database?: DatabaseSync;
  constructor(readonly directory: string) {}
  async acquire() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    assert(
      stat.isDirectory() &&
        !(stat.mode & 0o077) &&
        (await realpath(this.directory)) === path.resolve(this.directory),
      "Codex Wire requires private local storage without symbolic links.",
    );
    const filename = path.join(this.directory, ".owner.sqlite");
    const file = await open(
      filename,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const s = await file.stat();
      assert(
        s.isFile() && !(s.mode & 0o077),
        "The native owner lease must be a private regular file.",
      );
    } finally {
      await file.close();
    }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(filename);
      db.exec(
        "PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS lease (version INTEGER); DELETE FROM lease; INSERT INTO lease VALUES (3);",
      );
      this.database = db;
    } catch {
      db?.close();
      throw new CodexError(
        "storage",
        "Another Codex Wire Service owns this Manager. Keep only one active service workflow for this credential.",
      );
    }
    try {
      // v0.1.0 always mkdirs this path first. It must remain permanently occupied.
      for (const guardName of [".codex-wire-owner-v2", ".codex-wire-owner"]) {
        const guard = path.join(this.directory, guardName);
        const temporary = path.join(this.directory, `.native-barrier-${randomUUID()}`);
        await atomicWrite(temporary, BARRIER);
        try {
          try {
            await link(temporary, guard);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
          const guarded = await lstat(guard);
          // The first unreleased proof used a complete private marker directory.
          // Recognize it without removing/replacing it; an incomplete/old lock still fails closed.
          const marker =
            guarded.isDirectory() && !(guarded.mode & 0o077)
              ? path.join(guard, "native-format.json")
              : guard;
          assert(
            (await readPrivateFile(marker, 1024)) === BARRIER,
            "An old or unknown owner lock exists. Native setup cannot adopt an active or abandoned legacy store.",
          );
          const directory = await open(this.directory, "r");
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        } finally {
          await unlink(temporary);
        }
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close() {
    if (this.database) {
      this.database.close();
      this.database = undefined;
    }
  }
}
