"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
const source = "/source",
  output = "/output",
  work = path.join(output, "work");
if (fs.existsSync(work))
  throw Error(
    "Build output already exists. Preserve it and select an approved fresh checkpoint before rebuilding.",
  );
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(path.join(output, "tmp"), { recursive: true });
for (const name of [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "src",
  "scripts",
  "test",
  "integration",
  "README.md",
  "LICENSE",
  "docs",
  "examples",
  "compatibility.json",
  "Dockerfile.gateway",
  "compose.gateway.example.yaml",
])
  if (fs.existsSync(path.join(source, name)))
    fs.cpSync(path.join(source, name), path.join(work, name), {
      recursive: true,
      filter: (entry) => path.basename(entry) !== "node_modules" && path.basename(entry) !== ".test-state",
    });
const env = {
  ...process.env,
  npm_config_cache: "/npm-cache",
  NPM_CONFIG_CACHE: "/npm-cache",
  TMPDIR: "/output/tmp",
  CODEX_WIRE_SDK_ROOT: path.join(work, "integration/consumer/node_modules"),
};
function run(command, args, cwd = work) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.status !== 0) throw Error(command + " failed");
}
run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
run(
  "npm",
  ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
  path.join(work, "integration/consumer"),
);
run("npm", ["run", "build"]);
run("npm", ["test"]);
run("node", ["integration/scripts/build-overlay.cjs", "/upstream", path.join(output, "overlay")]);
run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], path.join(work, "integration/security"));
const securityOutput = path.join(output, "security");
run("node", ["integration/security/build-security.cjs", "/upstream", securityOutput]);
run("node", ["integration/security/prepare-os.cjs", path.join(securityOutput, "os")]);
env.CODEX_WIRE_SECURITY_BUILD = securityOutput;
env.CODEX_WIRE_UPSTREAM_SOURCE = "/upstream";
env.CODEX_WIRE_ORIGINAL_SMARTQUOTES = path.join(work, "integration/security/node_modules/markdown-it/lib/rules_core/smartquotes.js");
env.CODEX_WIRE_ORIGINAL_MARKDOWN = path.join(work, "integration/security/node_modules/markdown-it/lib");
env.CODEX_WIRE_OS_INPUT_DIR = path.join(securityOutput, "os/apks");
run("node", ["--test", "integration/security/security.test.cjs"]);
run("node", ["--test", "integration/security/os.test.cjs"]);
fs.mkdirSync(path.join(output, "artifacts"));
run("npm", ["pack", "--ignore-scripts", "--pack-destination", path.join(output, "artifacts")]);
const installSeed = path.join(output, "install-seed");
fs.mkdirSync(installSeed);
const sourceManifest = JSON.parse(fs.readFileSync(path.join(work, "package.json")));
fs.writeFileSync(
  path.join(installSeed, "package.json"),
  JSON.stringify({ private: true, dependencies: sourceManifest.dependencies }),
);
run(
  "npm",
  [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--bin-links=false",
    "--install-strategy=shallow",
    "--logs-max=0",
    "--cache",
    path.join(output, "install-cache"),
  ],
  installSeed,
);
fs.copyFileSync(
  path.join(installSeed, "package-lock.json"),
  path.join(output, "artifacts", "community-dependencies-lock.json"),
);
run("npm", ["prune", "--omit=dev", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund"]);
const runtime = path.join(output, "runtime");
fs.mkdirSync(runtime);
for (const name of ["package.json", "package-lock.json", "dist", "node_modules"])
  fs.cpSync(path.join(work, name), path.join(runtime, name), { recursive: true });
// Match the audited production dependency exclusions in Dockerfile.n8n.
for (const name of [
  "fast-uri/test",
  "fast-uri/types/index.test-d.ts",
  "fast-uri/benchmark",
  "json-schema-traverse/spec",
])
  fs.rmSync(path.join(runtime, "node_modules", name), { recursive: true, force: true });
fs.copyFileSync(path.join(work, "Dockerfile.gateway"), path.join(output, "gateway.Dockerfile"));
for (const name of ["n8n", "fixture"])
  fs.copyFileSync(
    path.join(work, "integration/qualification/Dockerfile." + name),
    path.join(output, name + ".Dockerfile"),
  );
fs.cpSync(path.join(work, "integration/qualification"), path.join(output, "qualification"), {
  recursive: true,
});
console.log(
  "Bounded candidate build, tests, package and matched-source overlay completed. Image assembly performs no dependency installation.",
);
