'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../../node_modules/typescript');
const { applyBackports } = require('./apply-backports.cjs');
const { sha256, verify, treeInventory } = require('./backport-inputs.cjs');
const source = path.resolve(process.argv[2] || '');
const output = path.resolve(process.argv[3] || '');
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node build-security.cjs <patched-n8n-source> <fresh-output>');
if (fs.existsSync(output)) throw new Error('Preserve prior security output and select a fresh checkpoint.');
const sourceManifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'source-manifest.json')));
const imageManifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'image-manifest.json')));
const roots = imageManifest.packageRoots;
const destinations = [
  ['packages/cli/src/', roots.n8n.path + '/dist/', 'cjs'],
  ['packages/@n8n/nodes-langchain/', roots['@n8n/n8n-nodes-langchain'].path + '/dist/', 'cjs'],
  ['packages/@n8n/mcp-browser/src/', roots['@n8n/mcp-browser'].path + '/dist/', 'cjs'],
  ['packages/@n8n/ai-utilities/src/', roots['@n8n/ai-utilities'].path + '/dist/cjs/', 'cjs'],
  ['packages/@n8n/ai-utilities/src/', roots['@n8n/ai-utilities'].path + '/dist/esm/', 'esm'],
];
const files = [];
fs.mkdirSync(output, { recursive: true });
for (const [relative, entry] of Object.entries(sourceManifest)) {
  const bytes = fs.readFileSync(path.join(source, relative));
  verify(bytes, entry.after, relative);
  if (!relative.endsWith('.ts')) continue;
  for (const [prefix, destination, format] of destinations) {
    if (!relative.startsWith(prefix)) continue;
    const rewriteCli = context => file => {
      const visit = node => {
        if (ts.isStringLiteral(node) && node.text.startsWith('@/') && relative.startsWith('packages/cli/')) {
          let specifier = path.posix.relative(path.posix.dirname(relative), 'packages/cli/src/' + node.text.slice(2));
          if (!specifier.startsWith('.')) specifier = './' + specifier;
          return ts.factory.createStringLiteral(specifier);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return ts.visitNode(file, visit);
    };
    const result = ts.transpileModule(bytes.toString(), { fileName: relative, reportDiagnostics: true,
      transformers: { before: [rewriteCli] }, compilerOptions: {
        module: format === 'cjs' ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
        experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true,
      } });
    if (result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error(`Security overlay compilation failed: ${relative}`);
    const target = destination + relative.slice(prefix.length).replace(/\.ts$/, '.js');
    fs.mkdirSync(path.dirname(path.join(output, 'overlay', target)), { recursive: true });
    fs.writeFileSync(path.join(output, 'overlay', target), result.outputText);
    files.push({ source: relative, sourceHash: entry.after, target, sha256: sha256(result.outputText) });
    if (relative.endsWith('/mcp-input-limits.ts')) {
      const declarations = ts.transpileDeclaration(bytes.toString(), { fileName: relative,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
      if (declarations.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error('Security helper declaration emission failed.');
      const declarationTarget = target.replace(/\.js$/, '.d.ts');
      fs.writeFileSync(path.join(output, 'overlay', declarationTarget), declarations.outputText);
      files.push({ source: relative, sourceHash: entry.after, target: declarationTarget, sha256: sha256(declarations.outputText) });
    }
  }
}
fs.cpSync(path.join(__dirname, 'node_modules'), path.join(output, 'node_modules'), { recursive: true, dereference: false, verbatimSymlinks: true });
const backports = applyBackports(path.join(output, 'node_modules'));
fs.mkdirSync(path.join(output, 'tools'));
for (const name of ['install-security.cjs', 'install-os.cjs', 'os-utils.cjs', 'os', 'patch-editor.cjs', 'backport-inputs.cjs', 'backports', 'editor-manifest.json', 'image-manifest.json', 'source-manifest.json', 'package.json', 'package-lock.json'])
  fs.cpSync(path.join(__dirname, name), path.join(output, 'tools', name), { recursive: true });
const metadata = JSON.parse(fs.readFileSync(path.join(source, 'packages/@n8n/ai-utilities/package.json')));
const helperExport = { typesVersions: metadata.typesVersions['*']['mcp-input-limits'], exports: metadata.exports['./mcp-input-limits'] };
fs.writeFileSync(path.join(output, 'build-manifest.json'), JSON.stringify({ compiler: ts.version, files, backports, helperExport, dependencies: treeInventory(path.join(output, 'node_modules')), lockHash: sha256(fs.readFileSync(path.join(__dirname, 'package-lock.json'))) }, null, 2) + '\n');
console.log(`Compiled ${files.length} exact-source security outputs and ${backports.length} compatible runtime backports.`);
