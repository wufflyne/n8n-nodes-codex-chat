'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { sha256, verify, verifyTree } = require('./backport-inputs.cjs');
const { patchEditor } = require('./patch-editor.cjs');

function installSecurity(root, bundle) {
  root = path.resolve(root); bundle = path.resolve(bundle);
  if (root === '/' && process.env.CODEX_WIRE_IMAGE_BUILD !== '1') throw new Error('Root installation is reserved for the explicit image build recipe.');
  if (fs.realpathSync(root) !== root) throw new Error('The image root must not contain symbolic-link components.');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'image-manifest.json')));
  const build = JSON.parse(fs.readFileSync(path.join(bundle, 'build-manifest.json')));
  const joinRoot = relative => {
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('Invalid image target.');
    const target = path.join(root, relative);
    let existing = target;
    while (!fs.existsSync(existing)) {
      // existsSync follows links, so explicitly reject a dangling link before walking upward.
      try { if (fs.lstatSync(existing).isSymbolicLink()) throw new Error('An image target contains a dangling symbolic link.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      existing = path.dirname(existing);
    }
    const resolved = fs.realpathSync(existing);
    if (root !== '/' && resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('An image target escapes the selected root through a symbolic link.');
    return target;
  };
  // Validate all write locations before any dependency replacement or output copy.
  for (const entry of manifest.replacePackages) joinRoot(entry.path);
  for (const entry of Object.values(manifest.packageRoots)) joinRoot(entry.path);
  for (const file of build.files) joinRoot(file.target);
  joinRoot('opt/codex-wire-security/node_modules');
  joinRoot('opt/codex-wire-security/receipts');
  verifyTree(path.join(bundle, 'node_modules'), build.dependencies);
  // Check every original package and every generated output before replacing anything.
  for (const entry of manifest.replacePackages) {
    const directory = joinRoot(entry.path);
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('A pinned physical package directory changed.');
    verify(fs.readFileSync(path.join(directory, 'package.json')), entry.beforePackageHash, entry.path);
    const replacement = JSON.parse(fs.readFileSync(path.join(bundle, 'node_modules', entry.replacement, 'package.json')));
    if (replacement.name !== entry.name) throw new Error('Replacement package identity differs.');
  }
  for (const [name, entry] of Object.entries(manifest.packageRoots))
    verify(fs.readFileSync(joinRoot(entry.path + '/package.json')), entry.packageHash, name);
  for (const file of build.files) verify(fs.readFileSync(path.join(bundle, 'overlay', file.target)), file.sha256, file.target);
  const installedModules = joinRoot('opt/codex-wire-security/node_modules');
  if (path.join(bundle, 'node_modules') !== installedModules) {
    if (fs.existsSync(installedModules)) throw new Error('The image security dependency destination already exists.');
    fs.mkdirSync(path.dirname(installedModules), { recursive: true });
    fs.cpSync(path.join(bundle, 'node_modules'), installedModules, { recursive: true, verbatimSymlinks: true });
  }
  const replacements = [];
  for (const entry of manifest.replacePackages) {
    const target = joinRoot(entry.path), replacement = path.join(installedModules, entry.replacement);
    fs.rmSync(target, { recursive: true });
    fs.symlinkSync(path.relative(path.dirname(target), replacement), target, 'dir');
    const metadata = JSON.parse(fs.readFileSync(path.join(target, 'package.json')));
    replacements.push({ ...entry, afterVersion: metadata.version, afterPackageHash: sha256(fs.readFileSync(path.join(target, 'package.json'))), resolved: path.relative(root, fs.realpathSync(target)) });
  }
  for (const file of build.files) {
    const target = joinRoot(file.target); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(bundle, 'overlay', file.target), target);
  }
  const utilityPackage = joinRoot(manifest.packageRoots['@n8n/ai-utilities'].path + '/package.json');
  const utility = JSON.parse(fs.readFileSync(utilityPackage));
  utility.typesVersions['*']['mcp-input-limits'] = build.helperExport.typesVersions;
  utility.exports['./mcp-input-limits'] = build.helperExport.exports;
  fs.writeFileSync(utilityPackage, JSON.stringify(utility, null, 2) + '\n');
  const recordDir = joinRoot('opt/codex-wire-security/receipts'); fs.mkdirSync(recordDir, { recursive: true });
  const editor = patchEditor(joinRoot(manifest.packageRoots['n8n-editor-ui'].path + '/dist'), path.join(recordDir, 'editor-assets.json'));
  const sdk = createRequire(path.join(installedModules, '@modelcontextprotocol/sdk/package.json'));
  const core = createRequire(path.join(installedModules, '@modelcontextprotocol/core/package.json'));
  const server = createRequire(path.join(installedModules, '@modelcontextprotocol/server/package.json'));
  const node = createRequire(path.join(installedModules, '@modelcontextprotocol/node/package.json'));
  if (node.resolve('@modelcontextprotocol/server') !== server.resolve('@modelcontextprotocol/server')) throw new Error('MCP node/server peer identity differs.');
  if (server.resolve('@modelcontextprotocol/core') !== core.resolve('@modelcontextprotocol/core')) throw new Error('MCP server/core identity differs.');
  const identity = { sdkZod: path.relative(root, sdk.resolve('zod')), serverZod: path.relative(root, server.resolve('zod')), coreZod: path.relative(root, core.resolve('zod')) };
  if (!identity.sdkZod.startsWith('opt/codex-wire-security/node_modules/zod/')) throw new Error('The shared Zod 3 peer identity differs.');
  const receipt = { baseDigest: manifest.baseDigest, lockHash: build.lockHash, replacements, overlay: build.files,
    utilityPackageHash: sha256(fs.readFileSync(utilityPackage)), editorRevision: editor.revision, identity };
  fs.writeFileSync(path.join(recordDir, 'installation.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
module.exports = { installSecurity };
if (require.main === module) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node install-security.cjs <image-root> <built-security-bundle>');
  const receipt = installSecurity(process.argv[2], process.argv[3]);
  console.log(`Installed ${receipt.replacements.length} pinned physical package replacements and the separate security source overlay.`);
}
