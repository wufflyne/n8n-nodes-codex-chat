// Resolve the exact versions shipped by the pinned n8n image instead of loading a second LangChain copy.
const fs = require("node:fs");
const path = require("node:path");
const root = "/usr/local/lib/node_modules/n8n/node_modules";
const target = "/opt/n8n-codex/node_modules";
const pnpm = path.join(root, ".pnpm");
const candidates = fs
  .readdirSync(pnpm)
  .filter((name) => name.startsWith("@langchain+core@1.2.8_"));
if (candidates.length !== 1)
  throw new Error(
    "The pinned n8n image must contain exactly one LangChain core 1.2.8 package.",
  );
const langchain = path.join(
  pnpm,
  candidates[0],
  "node_modules/@langchain/core",
);
const workflow = path.join(root, "n8n-workflow");
if (
  require(path.join(langchain, "package.json")).version !== "1.2.8" ||
  require(path.join(workflow, "package.json")).version !== "2.45.3"
)
  throw new Error("The runtime dependency versions do not match this release.");
fs.mkdirSync(path.join(target, "@langchain"), { recursive: true });
for (const [source, destination] of [
  [langchain, path.join(target, "@langchain/core")],
  [workflow, path.join(target, "n8n-workflow")],
])
  fs.symlinkSync(source, destination, "dir");
