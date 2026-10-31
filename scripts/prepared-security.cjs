'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sha256, verify, verifyTree } = require('../integration/security/backport-inputs.cjs');
const { verifyApk } = require('../integration/security/os-utils.cjs');

function preparedSecurity(root, selected) {
  if (!selected || !path.isAbsolute(selected)) throw new Error('Set CODEX_RELEASE_SECURITY_BUNDLE to the absolute security directory from a completed matched bounded build.');
  const directory = fs.realpathSync(selected), source = path.join(root, 'integration/security');
  const build = JSON.parse(fs.readFileSync(path.join(directory, 'build-manifest.json')));
  if (build.compiler !== '5.9.3') throw new Error('The prepared security compiler is not the pinned version.');
  verify(fs.readFileSync(path.join(source, 'package-lock.json')), build.lockHash, 'prepared security lock');
  verifyTree(path.join(directory, 'node_modules'), build.dependencies);
  const inputs = [];
  function checkInputs(relative = '') {
    for (const entry of fs.readdirSync(path.join(directory, 'tools', relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) checkInputs(name);
      else {
        if (!entry.isFile()) throw new Error('Prepared security tools must be regular files.');
        const expected = sha256(fs.readFileSync(path.join(source, name)));
        verify(fs.readFileSync(path.join(directory, 'tools', name)), expected, name);
        inputs.push({ path: name, sha256: expected });
      }
    }
  }
  checkInputs();
  for (const required of ['install-security.cjs', 'install-os.cjs', 'source-manifest.json', 'os/manifest.json', 'package-lock.json'])
    if (!inputs.some(entry => entry.path === required)) throw new Error('The prepared security bundle is incomplete.');
  const sources = JSON.parse(fs.readFileSync(path.join(source, 'source-manifest.json')));
  for (const file of build.files) {
    if (sources[file.source]?.after !== file.sourceHash || path.isAbsolute(file.target) || file.target.split('/').includes('..')) throw new Error('Prepared security source lineage differs.');
    verify(fs.readFileSync(path.join(directory, 'overlay', file.target)), file.sha256, file.target);
  }
  for (const name of Object.keys(sources).filter(name => name.endsWith('.ts')))
    if (!build.files.some(file => file.source === name)) throw new Error('A required security source output is absent.');
  const os = JSON.parse(fs.readFileSync(path.join(source, 'os/manifest.json')));
  for (const entry of os.packages) {
    const archive = path.join(directory, 'os/apks', path.posix.basename(new URL(entry.url).pathname));
    verifyApk(fs.readFileSync(archive), entry, fs.readFileSync(path.join(directory, 'os/keys', entry.key)));
  }
  const tool = os.packages.find(entry => entry.package === 'apk-tools-static');
  verify(fs.readFileSync(path.join(directory, 'os/apk.static')), tool.files['sbin/apk.static'].sha256, 'prepared static APK tool');
  return { directory, manifestSha256: sha256(fs.readFileSync(path.join(directory, 'build-manifest.json'))), lockSha256: build.lockHash, inputs };
}
module.exports = { preparedSecurity };
