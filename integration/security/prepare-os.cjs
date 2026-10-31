'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyApk } = require('./os-utils.cjs');
const { sha256 } = require('./backport-inputs.cjs');
async function prepareOs(output, inputDirectory) {
  if (fs.existsSync(output)) throw new Error('Preserve earlier OS preparation and use a fresh output directory.');
  const source = path.join(__dirname, 'os'), manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json')));
  fs.mkdirSync(path.join(output, 'apks'), { recursive: true });
  fs.cpSync(path.join(source, 'keys'), path.join(output, 'keys'), { recursive: true });
  fs.copyFileSync(path.join(source, 'manifest.json'), path.join(output, 'manifest.json'));
  const verified = [];
  for (const entry of manifest.packages) {
    const filename = path.posix.basename(new URL(entry.url).pathname);
    let bytes;
    if (inputDirectory) bytes = fs.readFileSync(path.join(inputDirectory, filename));
    else {
      const response = await fetch(entry.url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!response.ok || Number(response.headers.get('content-length') || entry.bytes) !== entry.bytes) throw new Error(`Pinned APK download failed: ${entry.package}`);
      const chunks = []; let length = 0;
      for await (const chunk of response.body) { length += chunk.length; if (length > entry.bytes) throw new Error('APK download exceeds its pinned size.'); chunks.push(chunk); }
      bytes = Buffer.concat(chunks, length);
    }
    const key = fs.readFileSync(path.join(output, 'keys', entry.key)), files = verifyApk(bytes, entry, key);
    fs.writeFileSync(path.join(output, 'apks', filename), bytes);
    if (entry.package === 'apk-tools-static') {
      const binary = files.get('sbin/apk.static').data;
      const signature = files.get('sbin/apk.static.SIGN.RSA.sha256.' + entry.key).data;
      if (!crypto.verify('RSA-SHA256', binary, key, signature)) throw new Error('The static APK verifier signature differs.');
      fs.writeFileSync(path.join(output, 'apk.static'), binary, { mode: 0o755 });
    }
    verified.push({ package: entry.package, version: entry.version, sha256: sha256(bytes), controlSignature: 'RSA-SHA1', dataChecksum: 'SHA256', keySha256: entry.keySha256 });
  }
  fs.writeFileSync(path.join(output, 'preparation.json'), JSON.stringify({ verified, staticBinarySignature: 'RSA-SHA256', executedPackageManager: false }, null, 2) + '\n');
  return verified;
}
module.exports = { prepareOs };
if (require.main === module) {
  if (!process.argv[2]) throw new Error('Usage: node prepare-os.cjs <fresh-output> [verified-download-directory]');
  prepareOs(path.resolve(process.argv[2]), process.argv[3] && path.resolve(process.argv[3])).then(rows => console.log(`Prepared ${rows.length} signature-verified pinned APK inputs without executing them.`)).catch(error => { console.error(error); process.exitCode = 1; });
}
