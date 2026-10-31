import { createHash } from "node:crypto";
import { mkdir, readdir, lstat, readFile, copyFile, chmod, realpath, open } from "node:fs/promises";
import path from "node:path";
import { ProfileOwner } from "./owner.js";
import { ProfileStore } from "../auth/store.js";
import { assert } from "../core/errors.js";

async function manifest(
  directory: string,
  prefix = "",
): Promise<
  Array<{ path: string; kind: "file" | "directory"; bytes: number; sha256: string | null }>
> {
  const result: Array<{
    path: string;
    kind: "file" | "directory";
    bytes: number;
    sha256: string | null;
  }> = [];
  for (const name of (await readdir(path.join(directory, prefix))).sort()) {
    if (!prefix && name === ".codex-wire-owner-v2") continue;
    const relative = path.join(prefix, name),
      file = path.join(directory, relative),
      stat = await lstat(file);
    assert(!stat.isSymbolicLink(), "Migration does not follow symbolic links.");
    if (stat.isDirectory()) {
      assert((stat.mode & 0o077) === 0, "Migration requires private store directories.");
      result.push(
        { path: relative, kind: "directory", bytes: 0, sha256: null },
        ...(await manifest(directory, relative)),
      );
    } else {
      assert(
        stat.isFile() && (stat.mode & 0o077) === 0,
        "Migration requires private regular store files.",
      );
      result.push({
        path: relative,
        kind: "file",
        bytes: stat.size,
        sha256: createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      });
    }
  }
  return result;
}
/** Transfer the current store, including rotating-token and reset/import uncertainty fences. */
export async function transferCurrentStore(
  source: string,
  target: string,
  key: Buffer,
  oldOwnersStoppedAndFenced: boolean,
) {
  assert(
    oldOwnersStoppedAndFenced,
    "Stop every old owner and remove its store/key access before migration. New locks cannot fence version 0.0.4.",
  );
  assert(
    path.isAbsolute(source) &&
      path.isAbsolute(target) &&
      source !== target &&
      !target.startsWith(source + path.sep) &&
      !source.startsWith(target + path.sep),
    "Use independent absolute source and target directories.",
  );
  const owner = new ProfileOwner(source);
  await owner.acquire();
  try {
    const store = new ProfileStore(source, key, undefined, true),
      files = await manifest(source);
    for (const file of files)
      if (/^[a-f0-9-]{36}\.json\.enc$/.test(file.path)) await store.readId(file.path.slice(0, -9));
    await mkdir(target, { mode: 0o700 });
    assert(
      (await realpath(target)) === path.resolve(target),
      "Migration target cannot contain symlink components.",
    );
    for (const file of files) {
      const destination = path.join(target, file.path);
      if (file.kind === "directory") {
        await mkdir(destination, { mode: 0o700 });
        continue;
      }
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(path.join(source, file.path), destination, 1);
      await chmod(destination, 0o600);
      const handle = await open(destination, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    for (const directory of [
      ...files
        .filter((file) => file.kind === "directory")
        .map((file) => path.join(target, file.path))
        .reverse(),
      target,
      path.dirname(target),
    ]) {
      const handle = await open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const copied = await manifest(target);
    assert(
      JSON.stringify(copied) === JSON.stringify(files),
      "The transferred store does not match the current source. Preserve both copies for recovery.",
    );
    for (const file of files)
      if (/^[a-f0-9-]{36}\.json\.enc$/.test(file.path))
        await new ProfileStore(target, key, undefined, true).readId(file.path.slice(0, -9));
    return {
      schemaVersion: 1,
      profileEnvelopeVersion: 1,
      source,
      target,
      files,
      providerContacted: false,
      originalPreserved: true,
      warning:
        "Both copies contain sensitive current tokens. Start exactly one owner; never restore an older token backup to roll back code.",
    };
  } finally {
    await owner.close();
  }
}
