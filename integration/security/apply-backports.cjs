'use strict';
// Compile the reviewed upstream sources with the project's pinned compiler.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../../node_modules/typescript');
const { smartquotesBody, linkifyBody, sha256, verify } = require('./backport-inputs.cjs');
function applyBackports(modules) {
  const results = [];
  const directory = path.join(__dirname, 'backports/zod');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  const zod = path.join(modules, 'zod');
  if (JSON.parse(fs.readFileSync(path.join(zod, 'package.json'))).version !== manifest.packageVersion)
    throw new Error('The compatible Zod backport requires exactly 3.25.76.');
  for (const [relative, hashes] of Object.entries(manifest.files)) {
    const source = fs.readFileSync(path.join(directory, relative));
    verify(source, hashes.after, relative);
    const original = fs.readFileSync(path.join(zod, 'src', relative));
    if (![hashes.before, hashes.after].includes(sha256(original))) throw new Error(`Unexpected Zod source: ${relative}`);
    for (const [extension, moduleKind] of [['js', ts.ModuleKind.ESNext], ['cjs', ts.ModuleKind.CommonJS]]) {
      const result = ts.transpileModule(source.toString(), {
        fileName: relative, reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: moduleKind, esModuleInterop: true },
        transformers: extension === 'cjs' ? { before: [context => file => {
          const visit = node => ts.isStringLiteral(node) && node.text.startsWith('.') && node.text.endsWith('.js')
            ? ts.factory.createStringLiteral(node.text.slice(0, -3) + '.cjs') : ts.visitEachChild(node, visit, context);
          return ts.visitNode(file, visit);
        }] } : undefined,
      });
      if (result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error(`Backport compilation failed: ${relative}`);
      const target = path.join(zod, relative.replace(/\.ts$/, '.' + extension));
      const before = sha256(fs.readFileSync(target)), after = sha256(result.outputText);
      if (before !== hashes.runtime[extension] && before !== after) throw new Error(`Unexpected Zod runtime: ${relative}.${extension}`);
      fs.writeFileSync(target, result.outputText);
      results.push({ package: 'zod', path: path.relative(zod, target), before, after });
    }
    fs.writeFileSync(path.join(zod, 'src', relative), source);
  }
  const quotes = path.join(modules, 'markdown-it/lib/rules_core/smartquotes.js');
  const manifestQuotes = JSON.parse(fs.readFileSync(path.join(__dirname, 'backports/smartquotes/manifest.json')));
  const before = sha256(fs.readFileSync(quotes)), code = "'use strict';\n" + smartquotesBody();
  if (![manifestQuotes.targetSha256, sha256(code)].includes(before)) throw new Error('Unexpected markdown-it smartquotes implementation.');
  fs.writeFileSync(quotes, code);
  results.push({ package: 'markdown-it', path: 'lib/rules_core/smartquotes.js', before, after: sha256(code) });
  const linkify = JSON.parse(fs.readFileSync(path.join(__dirname, 'backports/linkify/manifest.json')));
  for (const [kind, entry] of Object.entries(linkify.files)) {
    const target = path.join(modules, 'markdown-it', entry.target);
    const before = sha256(fs.readFileSync(target)), code = "'use strict';\n" + linkifyBody(kind);
    if (![entry.targetSha256, sha256(code)].includes(before)) throw new Error(`Unexpected Markdown ${kind} linkify implementation.`);
    fs.writeFileSync(target, code);
    results.push({ package: 'markdown-it', path: entry.target, before, after: sha256(code) });
  }
  return results;
}
module.exports = { applyBackports, smartquotesBody, sha256, verify };
if (require.main === module) {
  const modules = path.resolve(process.argv[2] || path.join(__dirname, 'node_modules'));
  const results = applyBackports(modules);
  if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(results, null, 2) + '\n');
  console.log(`Applied ${results.length} exact-source runtime backports.`);
}
