'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha256, verify } = require('./backport-inputs.cjs');
const { verifyApk } = require('./os-utils.cjs');

function packages(text) {
  return new Map(text.trim().split('\n\n').map(block => {
    const lines = block.split('\n'), name = lines.find(line => line.startsWith('P:'))?.slice(2), version = lines.find(line => line.startsWith('V:'))?.slice(2);
    if (!name || !version) throw new Error('Invalid installed APK metadata.'); return [name, version];
  }));
}
function installOs(directory) {
  if (process.env.CODEX_WIRE_IMAGE_BUILD !== '1' || directory !== '/opt/codex-wire-security/os') throw new Error('OS installation is restricted to the reviewed image assembly recipe.');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'os/manifest.json'))), database = '/lib/apk/db/installed';
  const beforeBytes = fs.readFileSync(database); verify(beforeBytes, manifest.beforeInstalledDatabaseSha256, 'original installed APK database');
  const before = packages(beforeBytes.toString()), inputs = [];
  for (const entry of manifest.packages) {
    const filename = path.join(directory, 'apks', path.posix.basename(new URL(entry.url).pathname));
    verifyApk(fs.readFileSync(filename), entry, fs.readFileSync(path.join(directory, 'keys', entry.key)));
    if (entry.package !== 'apk-tools-static') {
      if (before.get(entry.package) !== manifest.beforeVersions[entry.package]) throw new Error('Unexpected original OS package version.');
      inputs.push(filename);
    } else verify(fs.readFileSync(path.join(directory, 'apk.static')), entry.files['sbin/apk.static'].sha256, 'static APK verifier');
  }
  const result = spawnSync(path.join(directory, 'apk.static'), ['--no-network', '--no-cache', '--no-scripts', '--no-progress', '--keys-dir', path.join(directory, 'keys'), '--repositories-file', '/dev/null', 'add', '--upgrade', ...inputs], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('The offline pinned OS package update failed.');
  const afterBytes = fs.readFileSync(database), after = packages(afterBytes.toString());
  if (after.size !== before.size) throw new Error('The OS update changed the package inventory beyond the three approved replacements.');
  for (const [name, version] of before) {
    const expected = manifest.packages.find(entry => entry.package === name)?.version ?? version;
    if (after.get(name) !== expected) throw new Error(`Unexpected installed package result: ${name}`);
  }
  const files = [];
  for (const entry of manifest.packages.filter(entry => entry.package !== 'apk-tools-static')) {
    for (const [relative, expected] of Object.entries(entry.files)) {
      const target = '/' + relative;
      if (expected.type === 'file') { verify(fs.readFileSync(target), expected.sha256, relative); files.push({ path: target, sha256: expected.sha256 }); }
      if (expected.type === 'symlink' && fs.readlinkSync(target) !== expected.link) throw new Error(`Unexpected installed library link: ${relative}`);
    }
  }
  for (const obsolete of manifest.obsoleteFiles) if (fs.existsSync('/' + obsolete)) throw new Error('An obsolete vulnerable OS library remains.');
  const receiptDir = '/opt/codex-wire-security/receipts'; fs.mkdirSync(receiptDir, { recursive: true });
  fs.writeFileSync(path.join(receiptDir, 'os-installation.json'), JSON.stringify({ baseImageDigest: manifest.baseImageDigest, beforeDatabaseHash: sha256(beforeBytes), afterDatabaseHash: sha256(afterBytes), installed: Object.fromEntries(after), files, offline: true, packageScriptsExecuted: false }, null, 2) + '\n');
  fs.rmSync(path.join(directory, 'apks'), { recursive: true }); fs.unlinkSync(path.join(directory, 'apk.static'));
  console.log('Verified exactly three compatible OS library replacements; temporary APK tool and archives removed from the image.');
}
module.exports = { packages };
if (require.main === module) installOs(process.argv[2]);
