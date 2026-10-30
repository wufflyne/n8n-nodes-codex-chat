import { mkdir, open, rmdir, lstat, realpath } from "node:fs/promises";
import { unlinkSync, rmdirSync } from "node:fs";
import path from "node:path";
import { WireError } from "../gateway/errors.js";

/** Locks are never stolen by age. Old releases must be stopped and fenced operationally. */
export class ProfileOwner {
  private held = false;
  private readonly exiting = () => {
    // The process exit event cannot run more asynchronous application work.
    // Unknown token/reset outcomes remain fenced in their own durable journals.
    if (this.held)
      try {
        unlinkSync(
          path.join(this.directory, ".codex-wire-owner", "owner.json"),
        );
        rmdirSync(path.join(this.directory, ".codex-wire-owner"));
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
      await mkdir(path.join(this.directory, ".codex-wire-owner"), {
        mode: 0o700,
      });
      this.held = true;
    } catch {
      throw new WireError(
        422,
        "owner_conflict",
        "Another owner or an abandoned owner lock exists. Stop all store users before deliberate recovery.",
      );
    }
    const file = await open(
      path.join(this.directory, ".codex-wire-owner", "owner.json"),
      "wx",
      0o600,
    );
    try {
      await file.writeFile(
        JSON.stringify({ version: 1, pid: process.pid, startedAt: Date.now() }),
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
        path.join(this.directory, ".codex-wire-owner", "owner.json"),
      );
      await rmdir(path.join(this.directory, ".codex-wire-owner"));
      this.held = false;
    }
    process.removeListener("exit", this.exiting);
  }
}
