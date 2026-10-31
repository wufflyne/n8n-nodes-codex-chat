'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { smartquotesBody, linkifyBody, sha256, verify } = require('./backport-inputs.cjs');

/** Exact-base asset replacement. Unchanged well-known static entry points keep their routing contract. */
function patchEditor(directory, receiptPath) {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'editor-manifest.json')));
  const quotes = JSON.parse(fs.readFileSync(path.join(__dirname, 'backports/smartquotes/manifest.json')));
  const linkify = JSON.parse(fs.readFileSync(path.join(__dirname, 'backports/linkify/manifest.json')));
  const inputs = new Map();
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const bytes = fs.readFileSync(path.join(directory, relative));
    verify(bytes, digest, relative); inputs.set(relative, bytes);
  }
  const revision = sha256(JSON.stringify({ files: manifest.files, algorithm: quotes.algorithmSha256, linkify, adapter: sha256(fs.readFileSync(path.join(__dirname, 'backport-inputs.cjs'))), rewriter: sha256(fs.readFileSync(__filename)) })).slice(0, 16);
  const mapping = {};
  for (const relative of inputs.keys()) {
    if (relative.startsWith('assets/') && /\.(?:js|css)$/.test(relative))
      mapping[relative] = relative.replace(/\.(js|css)$/, `.cw${revision}.$1`);
  }
  const basenames = new Map(Object.entries(mapping).map(([before, after]) => [path.posix.basename(before), path.posix.basename(after)]));
  if (basenames.size !== Object.keys(mapping).length) throw new Error('Ambiguous editor asset basenames.');
  const escaped = [...basenames.keys()].sort((a, b) => b.length - a.length).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const references = new RegExp(escaped.join('|'), 'g');
  const vendorPath = 'assets/vendor-xeDGQDt1.js';
  let vendor = inputs.get(vendorPath).toString();
  const existing = linkify.existingBundledLinkifyIt;
  const existingStart = vendor.indexOf(existing.start), existingEnd = vendor.indexOf(existing.end, existingStart);
  if (existingStart < 0 || existingEnd < 0) throw new Error('The pinned linkify-it module boundary changed.');
  verify(Buffer.from(vendor.slice(existingStart, existingEnd)), existing.sha256, 'existing fixed linkify-it module');
  for (const [kind, entry] of Object.entries(linkify.files)) {
    const start = vendor.indexOf(entry.bundleStart), end = vendor.indexOf(entry.bundleEnd, start);
    if (start < 0 || end < 0 || vendor.indexOf(entry.bundleStart, start + 1) >= 0) throw new Error(`The pinned ${kind} linkify module boundary changed.`);
    verify(Buffer.from(vendor.slice(start, end)), entry.bundleModuleSha256, `bundled ${kind} linkify module`);
    const replacement = entry.bundleStart + 'const module=t;\n' + linkifyBody(kind) + '\n})), ';
    new vm.Script('(function(i){let ' + replacement + 'unused=0;})');
    vendor = vendor.slice(0, start) + replacement + vendor.slice(end);
  }
  const start = vendor.indexOf('TOe=i(((e,t)=>{'), end = vendor.indexOf('EOe=i(', start);
  if (start < 0 || end < 0 || vendor.indexOf('TOe=i(((e,t)=>{', start + 1) >= 0) throw new Error('The pinned smartquotes module boundary changed.');
  verify(Buffer.from(vendor.slice(start, end)), quotes.bundleModuleSha256, 'bundled smartquotes module');
  const replacement = 'TOe=i(((e,t)=>{const module=t;\n' + smartquotesBody('ap()') + '\n})), ';
  // Compile the isolated module before changing any assets; no code is executed here.
  new vm.Script('(function(i,ap){let ' + replacement + 'unused=0;})');
  inputs.set(vendorPath, Buffer.from(vendor.slice(0, start) + replacement + vendor.slice(end)));
  const writes = [], edges = [], after = {};
  for (const [relative, bytes] of inputs) {
    const destination = mapping[relative] ?? relative;
    let output = bytes;
    if (/\.(?:js|css|html)$/.test(relative)) {
      const source = bytes.toString('utf8');
      output = Buffer.from(source.replace(references, name => {
        const target = basenames.get(name);
        if (!target) throw new Error('Unknown asset reference.');
        edges.push({ from: destination, to: `assets/${target}` });
        return target;
      }));
      references.lastIndex = 0;
      if (references.test(output.toString())) throw new Error(`An old immutable asset URL remains in ${relative}.`);
    }
    writes.push({ relative, destination, bytes: output });
    after[destination] = sha256(output);
  }
  for (const edge of edges) if (!after[edge.to]) throw new Error(`An asset reference has no output: ${edge.to}`);
  // Only after all hashes, replacements and reference targets have been checked, write the new graph.
  for (const item of writes) fs.writeFileSync(path.join(directory, item.destination), item.bytes);
  for (const [oldName, newName] of Object.entries(mapping)) if (oldName !== newName) fs.unlinkSync(path.join(directory, oldName));
  const receipt = { imageDigest: manifest.imageDigest, revision, sourceAlgorithm: quotes.algorithmSha256, linkify,
    before: manifest.files, mapping, after, referenceEdges: edges,
    method: 'Every immutable JS/CSS chunk receives the deterministic input revision; all exact known asset filename references are rewritten. Well-known static routes, fonts and binary resources retain their names.' };
  if (receiptPath) fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
module.exports = { patchEditor };
if (require.main === module) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node patch-editor.cjs <exact-editor-dist> <receipt.json>');
  const receipt = patchEditor(path.resolve(process.argv[2]), path.resolve(process.argv[3]));
  console.log(`Revised ${Object.keys(receipt.mapping).length} immutable editor assets with verified references.`);
}
