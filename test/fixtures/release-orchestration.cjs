// Run the real release script against an in-memory Docker backend, never the host daemon.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const helpers = require("../../scripts/release-support.cjs");

const runtimeId = `sha256:${"a".repeat(64)}`;
const builderId = `sha256:${"b".repeat(64)}`;
const meta = { name: "n8n-nodes-codex-chat", version: "0.0.4" };

async function runRelease(directory, environment = {}, initialImages = []) {
  await fs.promises.mkdir(path.join(directory, "scripts"), { recursive: true });
  await fs.promises.writeFile(path.join(directory, "package.json"), JSON.stringify(meta));
  await fs.promises.writeFile(path.join(directory, "compose.portable.yaml"), "services:\n  n8n:\n    image: placeholder:0.0.4\n");
  const images = new Map(initialImages), commands = [], overwrites = [];
  const containers = new Set(), volumes = new Set();
  let stdout = "", stderr = "";
  const processStub = {
    env: { ...environment, CODEX_RELEASE_DOCKER: "direct" }, argv: [],
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
  };
  function assign(tag, id) {
    assert(id);
    if (images.has(tag) && images.get(tag) !== id)
      overwrites.push({ tag, previous: images.get(tag), next: id });
    images.set(tag, id);
  }
  function spawnSync(command, args) {
    assert.equal(command, "docker");
    commands.push([...args]);
    const option = (name) => args[args.indexOf(name) + 1];
    let output = "";
    switch (args[0]) {
      case "build": assign(option("-t"), args.includes("Dockerfile.build") ? builderId : runtimeId); break;
      case "create": containers.add(option("--name")); output = option("--name"); break;
      case "cp": fs.writeFileSync(path.join(args[2], `${meta.name}-${meta.version}.tgz`), "synthetic package bytes"); break;
      case "rm": for (const name of args.slice(1)) containers.delete(name); break;
      case "image":
        if (args[1] === "inspect") {
          if (!images.has(args[2])) return { status: 1, stdout: "", stderr: "Synthetic image absent" };
          output = images.get(args[2]);
        } else {
          assert.equal(args[1], "ls");
          output = images.get(args.at(-1).slice("reference=".length)) ?? "";
        }
        break;
      case "tag": assign(args[2], images.get(args[1])); break;
      case "run":
        if (args.includes("tar")) output = "package/package.json\npackage/dist/index.js\npackage/dist/cli.js";
        else if (args.includes("--detach")) containers.add(option("--name"));
        else output = JSON.stringify({ status: "passed", accountOrder: ["a", "b", "b"], toolTurns: 1 });
        break;
      case "volume":
        if (args[1] === "create") volumes.add(args.at(-1));
        else { assert.equal(args[1], "rm"); for (const name of args.slice(2)) volumes.delete(name); }
        break;
      case "exec": assert(args.some((value) => value.includes("/healthz/readiness"))); break;
      case "load":
        for (const [tag, id] of JSON.parse(fs.readFileSync(option("--input"), "utf8"))) assign(tag, id);
        break;
      default: assert.fail(`Unexpected fake Docker operation ${args[0]}`);
    }
    return { status: 0, stdout: output, stderr: "" };
  }
  function spawn(command, args) {
    assert.equal(command, "docker"); assert.equal(args[0], "save"); commands.push([...args]);
    const child = new EventEmitter();
    child.stdout = Readable.from([Buffer.from(JSON.stringify(args.slice(1).map((tag) => [tag, images.get(tag)])))]);
    child.stderr = Readable.from([]);
    child.kill = () => {};
    process.nextTick(() => child.emit("close", 0));
    return child;
  }
  function customRequire(specifier) {
    if (specifier === "node:child_process") return { spawnSync };
    if (specifier === "../package.json") return meta;
    if (specifier === "../compatibility.json") return {};
    if (specifier === "./release-support.cjs") return {
      ...helpers,
      releaseNames: (value) => helpers.releaseNames(value, environment),
      releaseImages: (value) => helpers.releaseImages(value, environment),
      exportImageArchive: (options) => helpers.exportImageArchive({ ...options, spawnImpl: spawn }),
    };
    return require(specifier);
  }
  await vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../../scripts/release-local.cjs"), "utf8"), {
    require: customRequire, __dirname: path.join(directory, "scripts"), process: processStub, setTimeout,
  });
  const manifestPath = path.join(directory, "artifacts/release-manifest.json");
  return {
    images, commands, overwrites, containers, volumes, stdout, stderr,
    exitCode: processStub.exitCode ?? 0,
    manifest: fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : undefined,
  };
}

module.exports = { runRelease, runtimeId, meta };
