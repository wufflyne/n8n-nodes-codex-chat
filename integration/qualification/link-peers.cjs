"use strict";
const fs = require("node:fs"),
  path = require("node:path");
const target = "/opt/codex-wire-context/node_modules",
  host = "/usr/local/lib/node_modules/n8n";
for (const name of ["n8n-workflow", "@langchain/core"]) {
  const resolved = require.resolve(name + "/package.json", {
    paths: [host, path.join(host, "node_modules/@n8n/n8n-nodes-langchain")],
  });
  const link = path.join(target, name);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.dirname(resolved), link, "dir");
}
