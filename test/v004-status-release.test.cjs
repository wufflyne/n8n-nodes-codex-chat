const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");
const { EventEmitter } = require("node:events");
const { planLabel, localStatus, verifiedDisplay } = require("../dist/auth/status");
const { emptySnapshot, parseUsage } = require("../dist/account/usage");
const { profile, session } = require("./helpers.cjs");
const { sourceInventory, hash, releaseImages, prepareImageTags, exportImageArchive } = require("../scripts/release-support.cjs");

async function temporary(t, suffix) {
  await fs.mkdir(".test-state", { recursive: true });
  const dir = await fs.mkdtemp(path.resolve(`.test-state/v004-${suffix}-`));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("Plan labels preserve known, absent and prototype-named unknown codes through status and usage JSON", () => {
  const known = [
    ["pro", "Pro"], ["prolite", "Pro Lite"], ["promax", "Pro Max"], ["plus", "Plus"],
    ["free", "Free"], ["team", "Team"], ["business", "Business"], ["enterprise", "Enterprise"], ["edu", "Edu"],
  ];
  const unknown = ["future-plan", "constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "__defineGetter__"];
  const now = Date.now();
  for (const [code, expected] of [...known, ...unknown.map((code) => [code, `Unknown plan (${code})`]), [null, null]]) {
    assert.equal(planLabel(code), expected);
    const p = profile({ profileId: "synthetic-profile", bindingSecret: "SYNTHETIC_BINDING" }, {
      display: verifiedDisplay({}, { chatgpt_plan_type: code }, now),
    });
    const local = JSON.parse(JSON.stringify(localStatus(p, false, now)));
    assert.equal(local.account.planCode, code);
    assert.equal(local.account.planLabel, expected);
    const base = emptySnapshot(localStatus(profile({ profileId: "synthetic-profile", bindingSecret: "SYNTHETIC_BINDING" }), false, now));
    const usage = JSON.parse(JSON.stringify(parseUsage(code === null ? {} : { plan_type: code }, base, session(), now)));
    assert.equal(usage.account.planCode, code);
    assert.equal(usage.account.planLabel, expected);
    assert.equal(usage.routing.decision, "unknown");
  }
});

test("Source inventory excludes nested private state and Git metadata files/directories without following symlinks", async (t) => {
  const dir = await temporary(t, "inventory");
  const publicFiles = ["package.json", "src/main.ts", ".env.example", "nested/.env.example", "test/regression.test.cjs"];
  const privateFiles = [".git/config", "nested/.git", ".env", ".env.local", "nested/.env.production", "secrets/runtime.env", "nested/secrets/key", "profiles/account", ".test-state/result", "artifacts/runtime.tar", "node_modules/dependency", "dist/main.js", ".npm-cache/index"];
  for (const name of [...publicFiles, ...privateFiles]) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), `SYNTHETIC ${name}\n`);
  }
  await fs.symlink(path.join(dir, "secrets"), path.join(dir, "linked-private"));
  const first = await sourceInventory(dir);
  assert.deepEqual(first.map((r) => r.path).sort(), publicFiles.sort());
  for (const row of first) assert.equal(row.sha256, await hash(path.join(dir, row.path)));
  await fs.writeFile(path.join(dir, ".git/config"), "CHANGED NONSECRET SENTINEL");
  assert.deepEqual(await sourceInventory(dir), first);
  await fs.writeFile(path.join(dir, "src/main.ts"), "changed authored source");
  assert.notDeepEqual(await sourceInventory(dir), first);
});

test("Custom release prefixes preserve the versioned documented image and deduplicate default export tags", () => {
  const normal = releaseImages({ version: "0.0.4" }, {});
  assert.equal(normal.documented, "codex-wire-v0-0-4-n8n:0.0.4");
  assert.deepEqual(normal.archiveTags, [normal.documented]);
  const custom = releaseImages({ version: "0.0.4" }, { CODEX_RELEASE_PREFIX: "work-synthetic" });
  assert.deepEqual(custom.archiveTags, ["work-synthetic-n8n:0.0.4", normal.documented]);
  assert.equal(custom.documented, normal.documented);
});

test("Image alias preparation checks all destinations before mutation and refuses foreign images", () => {
  const imageId = `sha256:${"a".repeat(64)}`, foreign = `sha256:${"b".repeat(64)}`;
  const calls = [], images = new Map([["source:0.0.4", imageId], ["foreign:0.0.4", foreign]]);
  const run = (args) => {
    calls.push(args);
    if (args[0] === "tag") { images.set(args[2], images.get(args[1])); return ""; }
    if (args[1] === "inspect") return images.get(args[2]);
    assert.equal(args[1], "ls");
    return images.get(args.at(-1).slice("reference=".length)) ?? "";
  };
  assert.throws(() => prepareImageTags(run, "source:0.0.4", ["missing:0.0.4", "foreign:0.0.4"]), /already refers to a different image/);
  assert.equal(calls.filter((a) => a[0] === "tag").length, 0);
  assert.equal(images.get("foreign:0.0.4"), foreign);
  assert.equal(prepareImageTags(run, "source:0.0.4", ["source:0.0.4", "alias:0.0.4", "alias:0.0.4"]), imageId);
  assert.deepEqual(calls.filter((a) => a[0] === "tag"), [["tag", "source:0.0.4", "alias:0.0.4"]]);
  prepareImageTags(run, "source:0.0.4", ["alias:0.0.4"]);
  assert.equal(calls.filter((a) => a[0] === "tag").length, 1);
});

test("Archive export passes only explicit unique tags and refuses repository-wide exports", async (t) => {
  const dir = await temporary(t, "tags"), calls = [];
  const spawnImpl = (_command, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = Readable.from([Buffer.from("synthetic image archive")]);
    child.stderr = Readable.from([]);
    child.kill = () => {};
    process.nextTick(() => child.emit("close", 0));
    return child;
  };
  const options = { docker: ["docker"], archive: path.join(dir, "image.tar"), cwd: dir, spawnImpl };
  await exportImageArchive({ ...options, images: ["custom:0.0.4", "stable:0.0.4", "custom:0.0.4"] });
  assert.deepEqual(calls, [["save", "custom:0.0.4", "stable:0.0.4"]]);
  for (const images of [[], ["repository"], ["--all-tags"], [undefined]])
    await assert.rejects(exportImageArchive({ ...options, images }), /explicit local image tags/);
  assert.equal(calls.length, 1);
});
