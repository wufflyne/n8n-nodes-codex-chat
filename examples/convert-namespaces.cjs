const fs = require("node:fs");
const path = require("node:path");
const [input, output, mode] = process.argv.slice(2);
if (
  !input ||
  !output ||
  !["custom", "community"].includes(mode) ||
  path.resolve(input) === path.resolve(output)
)
  throw Error("Specify distinct input/output files and custom|community.");
const names = new Set([
  "codexChatModel",
  "codexAccountTools",
  "codexAccountRouter",
  "codexImage",
]);
function convert(value) {
  if (Array.isArray(value)) return value.map(convert);
  if (!value || typeof value !== "object") return value;
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "type" && typeof item === "string") {
      const parts = item.split(".");
      copy[key] =
        parts.length === 2 &&
        ["CUSTOM", "n8n-nodes-codex-chat"].includes(parts[0]) &&
        names.has(parts[1])
          ? `${mode === "custom" ? "CUSTOM" : "n8n-nodes-codex-chat"}.${parts[1]}`
          : item;
    } else if (key === "workflowJson" && typeof item === "string") {
      copy[key] = JSON.stringify(convert(JSON.parse(item)));
    } else copy[key] = convert(item);
  }
  return copy;
}
fs.writeFileSync(
  output,
  JSON.stringify(convert(JSON.parse(fs.readFileSync(input, "utf8"))), null, 2) +
    "\n",
  { flag: "wx" },
);
