const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { releaseImages, releaseNames } = require("../scripts/release-support.cjs");
const { runRelease, runtimeId, meta } = require("./fixtures/release-orchestration.cjs");
const foreignId = `sha256:${"f".repeat(64)}`;
async function temporary(t) {
  await fs.mkdir(".test-state", { recursive: true });
  const directory = await fs.mkdtemp(path.resolve(".test-state/release-orchestration-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
function historicalImages(environment) {
  const { prefix } = releaseNames(meta, environment);
  return [[`${prefix}-build:0.0.4`, foreignId], [`${prefix}-loaded:0.0.4`, foreignId]];
}
const custom = { CODEX_RELEASE_PREFIX: "work-synthetic" };
for (const { name, environment, target } of [
  { name: "default runtime", environment: {}, target: "image" },
  { name: "custom runtime", environment: custom, target: "image" },
  { name: "custom documented", environment: custom, target: "documented" },
]) test(`Release orchestration preserves a conflicting ${name} tag before any promotion`, async (t) => {
  const directory = await temporary(t), names = releaseImages(meta, environment);
  const initial = [...historicalImages(environment), [names[target], foreignId]];
  const result = await runRelease(directory, environment, initial);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /already refers to a different image/);
  assert.deepEqual(result.overwrites, []);
  for (const [tag, id] of initial) assert.equal(result.images.get(tag), id);
  for (const tag of names.archiveTags) assert.equal(result.images.get(tag), new Map(initial).get(tag));
  assert.equal(result.commands.filter((args) => args[0] === "build").length, 2);
  assert.equal(result.commands.filter((args) => ["tag", "save", "load", "volume", "exec"].includes(args[0])).length, 0);
  assert.equal(result.manifest, undefined);
});

for (const environment of [{}, custom])
  test(`Release orchestration promotes ${environment.CODEX_RELEASE_PREFIX ? "custom" : "default"} tags and preserves earlier build/load checkpoints`, async (t) => {
    const directory = await temporary(t), names = releaseImages(meta, environment);
    const initial = historicalImages(environment);
    const first = await runRelease(path.join(directory, "first"), environment, initial);
    const second = await runRelease(path.join(directory, "second"), environment, first.images);
    for (const result of [first, second]) {
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(result.overwrites, []);
      for (const [tag, id] of initial) assert.equal(result.images.get(tag), id);
      for (const tag of names.archiveTags) assert.equal(result.images.get(tag), runtimeId);
      assert.deepEqual(result.commands.find((args) => args[0] === "save"), ["save", ...names.archiveTags]);
      assert.deepEqual(result.manifest.archiveTags, names.archiveTags);
      assert.equal(result.manifest.imageId, runtimeId);
      assert.equal(result.manifest.archiveLoadStart.emptyStateHealthy, true);
      assert.equal(result.containers.size, 0);
      assert.equal(result.volumes.size, 0);
      for (const key of ["buildImage", "stagingImage"])
        assert(!names.archiveTags.includes(result.manifest[key]));
    }
    for (const key of ["buildImage", "stagingImage"])
      assert.notEqual(first.manifest[key], second.manifest[key]);
    assert.notEqual(first.manifest.archiveLoadStart.loadedTag, second.manifest.archiveLoadStart.loadedTag);
    for (const [tag, id] of first.images) assert.equal(second.images.get(tag), id);
  });
