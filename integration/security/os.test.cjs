'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { verifyApk } = require('./os-utils.cjs');
const { sha256 } = require('./backport-inputs.cjs');
const manifest = require('./os/manifest.json');
const directory = process.env.CODEX_WIRE_OS_INPUT_DIR;
if (!directory) throw new Error('Set CODEX_WIRE_OS_INPUT_DIR to the prepared pinned APK directory.');
for (const entry of manifest.packages) test(`CW010-R13: ${entry.package} has a verified signature, index identity, payload and exact files`, () => {
  const bytes = fs.readFileSync(path.join(directory, path.posix.basename(new URL(entry.url).pathname)));
  const key = fs.readFileSync(path.join(__dirname, 'os/keys', entry.key));
  const files = verifyApk(bytes, entry, key);
  assert.equal(files.size, Object.keys(entry.files).length);
  const modified = Buffer.from(bytes); modified[modified.length - 16] ^= 1;
  assert.throws(() => verifyApk(modified, entry, key));
  const wrong = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => verifyApk(bytes, { ...entry, keySha256: sha256(wrong) }, wrong), /signature verification/);
});
