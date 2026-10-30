const fs = require("node:fs");
for (const name of ["CodexChatModel", "CodexAccount", "CodexAccountRouter", "CodexImage"])
  fs.copyFileSync(`src/nodes/${name}/codex.svg`, `dist/nodes/${name}/codex.svg`);
fs.cpSync("src/gateway/console", "dist/gateway/console", { recursive: true });
const crypto = require("node:crypto");
const artifact = crypto
  .createHash("sha256")
  .update(fs.readFileSync("src/integration/n8n-context.ts"))
  .update(fs.readFileSync("integration/n8n-2.45.6/manifest.json"))
  .digest("hex");
fs.writeFileSync(
  "dist/integration/context-build.json",
  JSON.stringify({
    protocolVersion: 1,
    release: "0.0.5",
    n8nVersion: "2.45.6",
    agentsVersion: "0.30.5",
    artifact,
  }) + "\n",
);
