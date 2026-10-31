'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { sha256 } = require('./backport-inputs.cjs');

/** Read the three independently compressed members of the pinned APK v2 format. */
function gzipMembers(bytes) {
  const members = [];
  while (bytes.length) {
    assert(members.length < 3 && bytes.length >= 18 && bytes.readUInt16LE(0) === 0x8b1f && bytes[2] === 8, 'Unexpected APK compression format.');
    const flags = bytes[3]; assert((flags & 0xe0) === 0, 'Invalid gzip flags.'); let offset = 10;
    if (flags & 4) { assert(offset + 2 <= bytes.length); const length = bytes.readUInt16LE(offset); offset += 2 + length; }
    for (const flag of [8, 16]) if (flags & flag) { const end = bytes.indexOf(0, offset); assert(end >= offset && end - offset <= 4096); offset = end + 1; }
    if (flags & 2) offset += 2;
    assert(offset < bytes.length);
    const inflated = zlib.inflateRawSync(bytes.subarray(offset), { info: true, maxOutputLength: 32 * 1024 * 1024 });
    const end = offset + inflated.engine.bytesWritten + 8; assert(end <= bytes.length);
    const compressed = bytes.subarray(0, end), data = zlib.gunzipSync(compressed, { maxOutputLength: 32 * 1024 * 1024 });
    members.push({ compressed, data }); bytes = bytes.subarray(end);
  }
  assert.equal(members.length, 3, 'An APK needs signature, control and data members.'); return members;
}
function tarFiles(bytes) {
  const entries = new Map(); let offset = 0;
  const text = (start, length) => bytes.subarray(start, start + length).toString('utf8').split('\0')[0];
  while (offset + 512 <= bytes.length && bytes.subarray(offset, offset + 512).some(value => value !== 0)) {
    const name = text(offset, 100), prefix = text(offset + 345, 155), filename = (prefix ? prefix + '/' + name : name).replace(/\/$/, '');
    assert(filename && !filename.startsWith('/') && !filename.split('/').includes('..') && !entries.has(filename) && entries.size < 32, 'Unsafe or unexpected APK member.');
    const sizeText = text(offset + 124, 12).trim(); assert(/^[0-7]+$/.test(sizeText)); const size = parseInt(sizeText, 8);
    assert(size <= 32 * 1024 * 1024 && offset + 512 + size <= bytes.length);
    const type = String.fromCharCode(bytes[offset + 156] || 48);
    const data = bytes.subarray(offset + 512, offset + 512 + size);
    if (type === 'x') {
      // These exact APKs carry only timestamps and APK checksum PAX metadata. No path/size override is accepted.
      assert(data.toString('utf8').trimEnd().split('\n').every(line => /^\d+ (?:[acm]time|APK-TOOLS\.checksum\.SHA1)=/.test(line)), 'Unexpected APK PAX metadata.');
    } else {
      assert(['0', '2', '5'].includes(type), 'Unsupported APK tar entry.');
      entries.set(filename, { type, link: text(offset + 157, 100), data });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
function verifyApk(bytes, entry, key) {
  assert.equal(bytes.length, entry.bytes); assert.equal(sha256(bytes), entry.sha256); assert.equal(sha256(key), entry.keySha256);
  const [signature, control, data] = gzipMembers(bytes);
  const signatures = tarFiles(signature.data), signed = signatures.get('.SIGN.RSA.' + entry.key);
  assert(signed && crypto.verify('RSA-SHA1', control.compressed, key, signed.data), 'APK control signature verification failed.');
  assert.equal('Q1' + crypto.createHash('sha1').update(control.compressed).digest('base64'), entry.indexIdentity);
  const info = tarFiles(control.data).get('.PKGINFO'); assert(info); assert.equal(info.data.toString('utf8'), entry.pkginfo);
  const dataHash = entry.pkginfo.split('\n').find(line => line.startsWith('datahash = '))?.slice(11);
  assert.equal(sha256(data.compressed), dataHash, 'APK data checksum differs.');
  const files = tarFiles(data.data); assert.deepEqual([...files.keys()].sort(), Object.keys(entry.files).sort());
  for (const [name, file] of files) {
    const expected = entry.files[name];
    assert.equal(file.type, { file: '0', directory: '5', symlink: '2' }[expected.type]);
    if (file.type === '0') assert.equal(sha256(file.data), expected.sha256);
    if (file.type === '2') assert.equal(file.link, expected.link);
  }
  return files;
}
module.exports = { verifyApk };
