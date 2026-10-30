const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  releaseNames,
  validatePackageEntries,
} = require("../scripts/release-support.cjs");
test("Release targets derive from package version and reject unsafe resource identifiers", () => {
  assert.deepEqual(releaseNames({ version: "0.0.2" }, {}), {
    prefix: "codex-wire-v0-0-2",
    label: "codex-wire.release=0.0.2",
  });
  assert.deepEqual(
    releaseNames(
      { version: "0.0.3" },
      {
        CODEX_RELEASE_PREFIX: "work-n8n-codex-v003-test",
        CODEX_RELEASE_TASK: "local_test-task",
      },
    ),
    { prefix: "work-n8n-codex-v003-test", label: "work.task=local_test-task" },
  );
  for (const prefix of [
    "",
    "../escape",
    "name:tag",
    "bad name",
    "CAPS",
    "a".repeat(81),
  ])
    assert.throws(
      () =>
        releaseNames({ version: "0.0.2" }, { CODEX_RELEASE_PREFIX: prefix }),
      /identifiers/,
    );
});
test("Release package guard rejects test, secret, traversal, map and dependency entries", () => {
  const required = [
    "package/package.json",
    "package/dist/index.js",
    "package/dist/cli.js",
  ];
  validatePackageEntries([
    ...required,
    "package/dist/nodes/CodexImage/CodexImage.node.d.ts",
    "package/docs/install.md",
    "package/examples/basic-chat.json",
  ]);
  for (const invalid of [
    "package/test/mock.cjs",
    "package/.env",
    "package/dist/../key.js",
    "package/dist/index.js.map",
    "package/node_modules/a.js",
    "package/src/model.ts",
  ])
    assert.throws(
      () => validatePackageEntries([...required, invalid]),
      /allowlist/,
    );
  assert.throws(
    () => validatePackageEntries(required.slice(0, 1)),
    /required runtime/,
  );
});


test("Archive export streams exact binary bytes into a caller-owned private file", async (t) => {
  const fs = require("node:fs/promises"), path = require("node:path"), { Readable } = require("node:stream"), { EventEmitter } = require("node:events");
  const { exportImageArchive } = require("../scripts/release-support.cjs");
  await fs.mkdir(".test-state", { recursive: true });
  const dir = await fs.mkdtemp(path.resolve(".test-state/archive-export-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from([0, 255, 10, 13, 128, 0, 42]), archive = path.join(dir, "runtime.tar");
  let actual;
  const spawnImpl = (command, args) => {
    actual = { command, args };
    const child = new EventEmitter(); child.stdout = Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]); child.stderr = Readable.from([]); child.kill = () => {};
    process.nextTick(() => child.emit("close", 0)); return child;
  };
  await exportImageArchive({ docker: ["sudo", "-n", "docker"], image: "local:test", archive, cwd: dir, spawnImpl });
  assert.deepEqual(actual, { command: "sudo", args: ["-n", "docker", "save", "local:test"] });
  assert.deepEqual(await fs.readFile(archive), bytes);
  const stat = await fs.stat(archive); assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.uid, process.getuid());
  assert.deepEqual(await fs.readdir(dir), ["runtime.tar"]);
});

test("Failed image export preserves an existing archive and removes only its partial temporary file", async (t) => {
  const fs = require("node:fs/promises"), path = require("node:path"), { Readable } = require("node:stream"), { EventEmitter } = require("node:events");
  const { exportImageArchive } = require("../scripts/release-support.cjs");
  await fs.mkdir(".test-state", { recursive: true }); const dir = await fs.mkdtemp(path.resolve(".test-state/archive-failure-")); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const archive = path.join(dir, "runtime.tar"); await fs.writeFile(archive, "prior valid archive", { mode: 0o600 });
  const spawnImpl = () => { const child = new EventEmitter(); child.stdout = Readable.from([Buffer.from("partial")]); child.stderr = Readable.from([]); child.kill = () => {}; process.nextTick(() => child.emit("close", 1)); return child; };
  await assert.rejects(exportImageArchive({ docker: ["docker"], image: "local:test", archive, cwd: dir, spawnImpl }), /previous archive was preserved/);
  assert.equal(await fs.readFile(archive, "utf8"), "prior valid archive"); assert.deepEqual(await fs.readdir(dir), ["runtime.tar"]);
});
