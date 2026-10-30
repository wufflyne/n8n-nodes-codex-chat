const fs = require("node:fs");
for (const name of [
  "CodexChatModel",
  "CodexAccount",
  "CodexAccountRouter",
  "CodexImage",
])
  fs.copyFileSync(
    `src/nodes/${name}/codex.svg`,
    `dist/nodes/${name}/codex.svg`,
  );
