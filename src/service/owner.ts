import { mkdir, open, rmdir, lstat, realpath, readdir } from "node:fs/promises";
import { unlinkSync, rmdirSync } from "node:fs";
import path from "node:path";
import { WireError } from "../gateway/errors.js";
import { atomicWrite, readPrivateFile } from "../auth/store.js";

const ACTIVE = ".codex-wire-owner-v2";
const LEGACY = ".codex-wire-owner";
const FORMAT = '{"format":"codex-wire-managed-store","version":2,"minimumOwnerVersion":"0.1.0"}';

/** Locks are never stolen by age. Old releases must be stopped and fenced operationally. */
export class ProfileOwner {
  private held = false;
  private readonly exiting = () => {
    // The process exit event cannot run more asynchronous application work.
    // Unknown token/reset outcomes remain fenced in their own durable journals.
    if (this.held)
      try {
        unlinkSync(
          path.join(this.directory, ACTIVE, "owner.json"),
        );
        rmdirSync(path.join(this.directory, ACTIVE));
        this.held = false;
      } catch {
        /* Preserve an abandoned fence when cleanup cannot be proven. */
      }
  };
  constructor(readonly directory: string) {}
  preserveFence() {
    process.removeListener("exit", this.exiting);
  }
  async acquire() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (
      stat.mode & 0o077 ||
      !stat.isDirectory() ||
      (await realpath(this.directory)) !== path.resolve(this.directory)
    )
      throw new WireError(
        422,
        "owner_directory",
        "The owner requires a private real profile directory.",
      );
    try {
      await mkdir(path.join(this.directory, ACTIVE), {
        mode: 0o700,
      });
      this.held = true;
    } catch {
      throw new WireError(
        422,
        "owner_conflict",
        "Another owner or an abandoned owner lock exists. Drain and stop n8n or the gateway before running the offline helper with the same image, installed package, volume, key and service user. Never remove a lock while an owner may still run.",
      );
    }
    try {
      const legacy = path.join(this.directory, LEGACY);
      let created = false;
      try { await mkdir(legacy, { mode: 0o700 }); created = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (created) await atomicWrite(path.join(legacy, "format.json"), FORMAT);
      else {
        const stat = await lstat(legacy), names = await readdir(legacy);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || names.length !== 1 || names[0] !== "format.json" || await readPrivateFile(path.join(legacy, "format.json"), 1024) !== FORMAT)
          throw new Error("Unrecognized legacy owner");
      }
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch {
      await rmdir(path.join(this.directory, ACTIVE)); this.held = false;
      throw new WireError(422, "owner_compatibility", "The old owner path is active, abandoned, or has an unknown format. Stop every store user and inspect it offline. Never convert an old lock by age or delete the permanent v0.1.0 format guard to downgrade.");
    }
    const file = await open(
      path.join(this.directory, ACTIVE, "owner.json"),
      "wx",
      0o600,
    );
    try {
      await file.writeFile(
        JSON.stringify({ version: 2, pid: process.pid, startedAt: Date.now() }),
      );
      await file.sync();
    } finally {
      await file.close();
    }
    process.once("exit", this.exiting);
  }
  async close() {
    if (this.held) {
      const { unlink } = await import("node:fs/promises");
      await unlink(
        path.join(this.directory, ACTIVE, "owner.json"),
      );
      await rmdir(path.join(this.directory, ACTIVE));
      this.held = false;
    }
    process.removeListener("exit", this.exiting);
  }
}
