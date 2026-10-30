"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const ts = require("../../node_modules/typescript");
const source = path.resolve(process.argv[2] || ""),
  output = path.resolve(process.argv[3] || "");
if (!process.argv[2] || !process.argv[3])
  throw new Error("Usage: node build-overlay.cjs <pinned-n8n-source> <output-directory>");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../n8n-2.45.6/manifest.json"))),
  results = {};
for (const [relative, entry] of Object.entries(manifest)) {
  const bytes = fs.readFileSync(path.join(source, relative));
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== entry.after)
    throw new Error("Patched source hash differs: " + relative);
  // Match the upstream tsc-alias build step for CLI @/ imports.
  const rewriteCliAlias = (context) => (file) => {
    const visitor = (node) => {
      if (
        ts.isStringLiteral(node) &&
        node.text.startsWith("@/") &&
        relative.startsWith("packages/cli/")
      ) {
        let specifier = path.posix.relative(
          path.posix.dirname(relative),
          "packages/cli/src/" + node.text.slice(2),
        );
        if (!specifier.startsWith(".")) specifier = "./" + specifier;
        return ts.factory.createStringLiteral(specifier);
      }
      return ts.visitEachChild(node, visitor, context);
    };
    return ts.visitNode(file, visitor);
  };
  const result = ts.transpileModule(bytes.toString(), {
    transformers: { before: [rewriteCliAlias] },
    fileName: relative,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
    },
  });
  const errors = (result.diagnostics || []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(errors, {
        getCanonicalFileName: (x) => x,
        getCurrentDirectory: () => source,
        getNewLine: () => "\n",
      }),
    );
  const destination = relative
    .replace("packages/@n8n/agents/src/", "agents/")
    .replace("packages/cli/src/", "cli/")
    .replace(/\.ts$/, ".js");
  fs.mkdirSync(path.dirname(path.join(output, destination)), { recursive: true });
  fs.writeFileSync(path.join(output, destination), result.outputText);
  results[destination] = crypto.createHash("sha256").update(result.outputText).digest("hex");
}
fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(results, null, 2) + "\n");
console.log(
  "Compiled " +
    Object.keys(results).length +
    " exact-source overlay files. Full upstream type qualification remains separate.",
);
