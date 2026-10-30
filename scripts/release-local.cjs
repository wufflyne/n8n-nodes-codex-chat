// Local release orchestration only. Docker targets are new task-scoped resources; existing deployments are untouched.
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const {
  releaseNames,
  releaseImages,
  prepareImageTags,
  hash,
  sourceInventory,
  validatePackageEntries,
  exportImageArchive,
} = require("./release-support.cjs");
const root = path.resolve(__dirname, ".."),
  meta = require("../package.json"),
  version = meta.version,
  { label, prefix } = releaseNames(meta);
const docker =
  process.env.CODEX_RELEASE_DOCKER === "direct"
    ? ["docker"]
    : ["sudo", "-n", "docker"];
function run(args, options = {}) {
  const result = spawnSync(docker[0], [...docker.slice(1), ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0)
    throw Error(
      `Local Docker release step failed: ${args[0]}. Review the captured local build evidence.`,
    );
  return result.stdout.trim();
}
async function main() {
  const disposable = `${prefix}-${randomUUID()}`;
  const initialSource = await sourceInventory(root);
  const evidenceIndex = process.argv.indexOf("--physical-evidence");
  let physicalEvidence;
  if (evidenceIndex >= 0) {
    if (!process.argv[evidenceIndex + 1])
      throw Error("Specify the physical evidence file.");
    const file = path.resolve(root, process.argv[evidenceIndex + 1]);
    physicalEvidence = {
      path: path.relative(root, file),
      sha256: await hash(file),
    };
  }
  const artifacts = path.join(root, "artifacts");
  await fs.mkdir(artifacts, { recursive: true });
  const { documented, archiveTags } = releaseImages(meta);
  // Build only private invocation tags; public destinations are checked before promotion.
  const build = `${disposable}-build:${version}`,
    image = `${disposable}-runtime:${version}`,
    loaded = `${disposable}-loaded:${version}`;
  const log = async (name, args) => {
    const result = spawnSync(docker[0], [...docker.slice(1), ...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    await fs.writeFile(
      path.join(artifacts, name),
      (result.stdout ?? "") + (result.stderr ?? ""),
    );
    if (result.status !== 0)
      throw Error(`Local release failed; inspect artifacts/${name}.`);
  };
  await log("build.log", [
    "build",
    "--label",
    label,
    "-f",
    "Dockerfile.build",
    "-t",
    build,
    ".",
  ]);
  const extract = `${disposable}-package-extract`;
  run(["create", "--name", extract, "--label", label, build]);
  try {
    run([
      "cp",
      `${extract}:/build/artifacts/n8n-nodes-codex-chat-${version}.tgz`,
      artifacts,
    ]);
  } finally {
    run(["rm", extract]);
  }
  const packageEntries = run([
    "run",
    "--rm",
    "--name",
    `${disposable}-package-inventory`,
    "--label",
    label,
    "--network",
    "none",
    "--entrypoint",
    "tar",
    build,
    "-tzf",
    `/build/artifacts/${meta.name}-${version}.tgz`,
  ])
    .split("\n")
    .filter(Boolean);
  validatePackageEntries(packageEntries);
  await log("runtime-build.log", [
    "build",
    "--label",
    label,
    "--build-arg",
    `BUILD_IMAGE=${build}`,
    "-f",
    "Dockerfile.n8n",
    "-t",
    image,
    ".",
  ]);
  const native = run([
    "run",
    "--rm",
    "--name",
    `${disposable}-release-native`,
    "--label",
    label,
    "--network",
    "none",
    "--mount",
    `type=bind,src=${path.join(root, "scripts/native-smoke.cjs")},dst=/probe/native-smoke.cjs,readonly`,
    "--entrypoint",
    "node",
    image,
    "/probe/native-smoke.cjs",
  ]);
  const nativeResult = JSON.parse(native);
  if (nativeResult.status !== "passed")
    throw Error("Native synthetic release smoke failed.");
  await fs.writeFile(
    path.join(artifacts, "native-smoke.json"),
    JSON.stringify(nativeResult, null, 2) + "\n",
  );
  const archive = path.join(artifacts, `codex-wire-n8n-${version}.tar`);
  const imageId = prepareImageTags(run, image, archiveTags);
  await exportImageArchive({ docker, images: archiveTags, archive, cwd: root });
  run(["load", "--input", archive]);
  for (const tag of archiveTags)
    if (run(["image", "inspect", tag, "--format", "{{.Id}}"]) !== imageId)
      throw Error("A loaded release tag does not match the built image.");
  run(["tag", documented, loaded]);
  const state = `${disposable}-release-empty-state`,
    profiles = `${disposable}-release-empty-profiles`,
    container = `${disposable}-release-empty`;
  run(["volume", "create", "--label", label, state]);
  run(["volume", "create", "--label", label, profiles]);
  let healthy = false;
  try {
    run([
      "run",
      "--detach",
      "--name",
      container,
      "--label",
      label,
      "--network",
      "none",
      "--mount",
      `type=volume,src=${state},dst=/home/node/.n8n`,
      "--mount",
      `type=volume,src=${profiles},dst=/var/lib/n8n-codex`,
      "--env",
      "N8N_DIAGNOSTICS_ENABLED=false",
      "--env",
      "N8N_VERSION_NOTIFICATIONS_ENABLED=false",
      "--env",
      "N8N_CODEX_STORE_DIR=/var/lib/n8n-codex/profiles",
      loaded,
    ]);
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const result = spawnSync(
        docker[0],
        [
          ...docker.slice(1),
          "exec",
          container,
          "node",
          "-e",
          "fetch('http://127.0.0.1:5678/healthz/readiness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ],
        { encoding: "utf8" },
      );
      if (result.status === 0) {
        healthy = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!healthy)
      throw Error("Loaded image did not become healthy on empty volumes.");
  } finally {
    try {
      run(["rm", "--force", container]);
    } finally {
      run(["volume", "rm", state, profiles]);
    }
  }
  await fs.writeFile(
    path.join(artifacts, "compose.portable.yaml"),
    (
      await fs.readFile(path.join(root, "compose.portable.yaml"), "utf8")
    ).replace(/^(\s+image:)\s+\S+/m, `$1 ${documented}`),
  );
  const inventory = await sourceInventory(root),
    sourceHash = createHash("sha256")
      .update(JSON.stringify(inventory))
      .digest("hex"),
    packageFile = path.join(artifacts, `n8n-nodes-codex-chat-${version}.tgz`),
    compat = require("../compatibility.json");
  if (JSON.stringify(inventory) !== JSON.stringify(initialSource))
    throw Error(
      "Authored source changed during release; rerun from a stable checkpoint.",
    );
  const manifest = {
    ...compat,
    packageVersion: version,
    status: "local-artifacts-built",
    sourceHash,
    sourceInventory: inventory,
    packageInventory: packageEntries,
    imageId: run(["image", "inspect", loaded, "--format", "{{.Id}}"]),
    buildImage: build,
    stagingImage: image,
    archiveTags,
    documentedImage: documented,
    nativeSmoke: nativeResult,
    archiveLoadStart: { loadedTag: loaded, emptyStateHealthy: healthy },
    artifacts: [],
  };
  for (const file of [
    packageFile,
    archive,
    path.join(artifacts, "compose.portable.yaml"),
  ])
    manifest.artifacts.push({
      name: path.basename(file),
      bytes: (await fs.stat(file)).size,
      sha256: await hash(file),
    });
  if (physicalEvidence) manifest.physicalEvidence = physicalEvidence;
  await fs.writeFile(
    path.join(artifacts, "release-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await fs.writeFile(
    path.join(artifacts, "SHA256SUMS"),
    manifest.artifacts.map((a) => `${a.sha256}  ${a.name}`).join("\n") +
      "\n" +
      `${await hash(path.join(artifacts, "release-manifest.json"))}  release-manifest.json\n`,
  );
  process.stdout.write(
    `Built local ${version} package/image/archive. Physical compatibility evidence remains a separate release gate.\n`,
  );
}
main().catch((error) => {
  process.stderr.write(error.message + "\n");
  process.exitCode = 1;
});
