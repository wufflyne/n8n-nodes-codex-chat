'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function verify(bytes, expected, label) {
  if (sha256(bytes) !== expected) throw new Error(`Unexpected backport input: ${label}`);
}
function smartquotesBody(utils = "require('../common/utils')") {
  const directory = path.join(__dirname, 'backports/smartquotes');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  const bytes = fs.readFileSync(path.join(directory, 'smartquotes.mjs'));
  verify(bytes, manifest.algorithmSha256, 'maintained smartquotes source');
  return bytes.toString().replace(
    "import { isWhiteSpace, isPunctCharCode, isMdAsciiPunct } from '../common/utils.mjs'",
    `const { isWhiteSpace, isPunctChar, isMdAsciiPunct } = ${utils};\nconst isPunctCharCode = code => isPunctChar(String.fromCharCode(code));`,
  ).replace('export default function smartquotes', 'module.exports = function smartquotes');
}
function linkifyBody(kind) {
  const directory = path.join(__dirname, 'backports/linkify');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
  const entry = manifest.files[kind];
  if (!entry) throw new Error('Unknown linkify backport.');
  const bytes = fs.readFileSync(path.join(directory, kind + '.mjs'));
  verify(bytes, entry.algorithmSha256, `maintained ${kind} linkify source`);
  return bytes.toString().replace('export default function linkify', 'module.exports = function linkify');
}
function treeInventory(directory, relative = '') {
  const entries = [];
  for (const item of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.posix.join(relative, item.name), filename = path.join(directory, name);
    if (item.isDirectory()) entries.push(...treeInventory(directory, name));
    else if (item.isFile()) entries.push({ path: name, sha256: sha256(fs.readFileSync(filename)) });
    else if (item.isSymbolicLink()) {
      const target = fs.readlinkSync(filename), resolved = path.resolve(path.dirname(filename), target);
      if (path.isAbsolute(target) || !resolved.startsWith(path.resolve(directory) + path.sep)) throw new Error('A security dependency link escapes its tree.');
      entries.push({ path: name, link: target });
    } else throw new Error('Unexpected security dependency file type.');
  }
  return entries;
}
function verifyTree(directory, expected) {
  if (!Array.isArray(expected) || !expected.length || JSON.stringify(treeInventory(directory)) !== JSON.stringify(expected)) throw new Error('Prepared security dependency contents differ from their build receipt.');
}
module.exports = { smartquotesBody, linkifyBody, treeInventory, verifyTree, sha256, verify };
