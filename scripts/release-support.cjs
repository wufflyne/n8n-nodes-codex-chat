// Scoped release helpers shared by the local pipeline and synthetic contract tests.
const fs = require("node:fs/promises");
const { createReadStream, createWriteStream } = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { pipeline } = require("node:stream/promises");

const PRIVATE_ENTRIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "artifacts",
  ".npm-cache",
  ".test-state",
  "profiles",
  "secrets",
]);
async function hash(file) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest("hex");
}
async function sourceInventory(directory, relative = "") {
  const rows = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (
      PRIVATE_ENTRIES.has(entry.name) ||
      (entry.name !== ".env.example" && entry.name.startsWith(".env"))
    )
      continue;
    const name = path.join(relative, entry.name);
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...(await sourceInventory(full, name)));
    else if (entry.isFile())
      rows.push({ path: name, sha256: await hash(full) });
  }
  return rows;
}

function releaseNames(meta, environment = process.env) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(meta.version))
    throw Error("The package release version is invalid.");
  const prefix =
    environment.CODEX_RELEASE_PREFIX ??
    `codex-wire-v${meta.version.replaceAll(".", "-")}`;
  const task = environment.CODEX_RELEASE_TASK;
  if (
    !/^[a-z0-9][a-z0-9_.-]{0,79}$/.test(prefix) ||
    (task !== undefined && !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(task))
  )
    throw Error("Use bounded lowercase release resource and task identifiers.");
  return {
    prefix,
    label: task ? `work.task=${task}` : `codex-wire.release=${meta.version}`,
  };
}
function releaseImages(meta, environment = process.env) {
  const { prefix } = releaseNames(meta, environment);
  const documented = `${releaseNames(meta, {}).prefix}-n8n:${meta.version}`;
  const image = `${prefix}-n8n:${meta.version}`;
  return {
    image,
    documented,
    archiveTags: [...new Set([image, documented])],
  };
}
function prepareImageTags(run, image, tags) {
  const imageId = run(["image", "inspect", image, "--format", "{{.Id}}"]);
  // Check every destination before creating any alias. Never overwrite an unrelated image.
  const missing = [];
  for (const tag of new Set(tags)) {
    const existing = run([
      "image",
      "ls",
      "--quiet",
      "--no-trunc",
      "--filter",
      `reference=${tag}`,
    ]);
    if (existing && existing !== imageId)
      throw Error(
        `Release image tag ${tag} already refers to a different image. Preserve it and choose a new package version, or verify and explicitly remove only an alias owned by your previous local release before retrying.`,
      );
    if (!existing) missing.push(tag);
  }
  for (const tag of missing) run(["tag", image, tag]);
  return imageId;
}
function validatePackageEntries(entries) {
  if (!entries.length || entries.length > 2048)
    throw Error("The local package inventory is empty or exceeds its bound.");
  for (const entry of entries) {
    if (
      entry.includes("..") ||
      entry.includes("\\") ||
      !/^package\/(?:package\.json|README\.md|LICENSE|compatibility\.json|Dockerfile\.gateway|compose\.gateway\.example\.yaml|dist\/[A-Za-z0-9_./-]+\.(?:js|d\.ts|svg)|dist\/gateway\/console\/(?:index\.html|console\.css)|dist\/integration\/context-build\.json|integration\/n8n-2\.45\.6\/(?:manifest\.json|model-request-context\.patch)|integration\/scripts\/build-overlay\.cjs|docs\/[A-Za-z0-9_-]+\.md|examples\/[A-Za-z0-9_-]+\.(?:json|cjs))$/.test(
        entry,
      )
    )
      throw Error(
        "The local package contains a file outside its runtime/documentation allowlist.",
      );
  }
  for (const required of [
    "package/package.json",
    "package/dist/index.js",
    "package/dist/cli.js",
  ])
    if (!entries.includes(required))
      throw Error("The local package is missing a required runtime entry.");
}
async function exportImageArchive({
  docker,
  image,
  images = [image],
  archive,
  cwd,
  spawnImpl,
}) {
  if (
    !images.length ||
    images.some(
      (tag) =>
        typeof tag !== "string" ||
        !/^[a-z0-9][a-z0-9_.-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(tag),
    )
  )
    throw Error("Export requires explicit local image tags.");
  const spawn = spawnImpl ?? require("node:child_process").spawn;
  const temporary = `${archive}.${randomUUID()}.tmp`;
  let child, transfer;
  try {
    child = spawn(docker[0], [...docker.slice(1), "save", ...new Set(images)], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.resume();
    const completed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve() : reject(Error("export failed")),
      );
    });
    const destination = createWriteStream(temporary, {
      flags: "wx",
      mode: 0o600,
    });
    transfer = pipeline(child.stdout, destination);
    await Promise.all([transfer, completed]);
    await fs.rename(temporary, archive);
  } catch {
    child?.kill();
    await transfer?.catch(() => undefined);
    throw Error(
      "Local image archive export failed; any previous archive was preserved.",
    );
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
module.exports = {
  hash,
  sourceInventory,
  releaseNames,
  releaseImages,
  prepareImageTags,
  validatePackageEntries,
  exportImageArchive,
};
