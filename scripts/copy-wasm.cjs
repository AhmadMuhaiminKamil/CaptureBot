'use strict';
// copy-wasm.cjs — copy tesseract.js-core WASM + worker + lang-data for Vercel
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const root = path.join(__dirname, '..');

// 1. Copy tesseract.js-core ke api/tesseract.js-core
const coreSrc  = path.join(root, 'node_modules', 'tesseract.js-core');
const coreDest = path.join(root, 'api', 'tesseract.js-core');
if (fs.existsSync(coreDest)) fs.rmSync(coreDest, { recursive: true });
fs.mkdirSync(coreDest, { recursive: true });
for (const file of fs.readdirSync(coreSrc)) {
  fs.copyFileSync(path.join(coreSrc, file), path.join(coreDest, file));
}
console.log('Copied tesseract.js-core');

// 2. Copy tesseract.js-core ke api/_core
const altCoreDest = path.join(root, 'api', '_core');
if (fs.existsSync(altCoreDest)) fs.rmSync(altCoreDest, { recursive: true });
fs.mkdirSync(altCoreDest, { recursive: true });
for (const file of fs.readdirSync(coreSrc)) {
  fs.copyFileSync(path.join(coreSrc, file), path.join(altCoreDest, file));
}
console.log('Copied tesseract.js-core to api/_core');

// 3. Copy worker script ke api/_worker/
const workerSrc  = path.join(root, 'node_modules', 'tesseract.js', 'src');
const workerDest = path.join(root, 'api', '_worker');
if (fs.existsSync(workerDest)) fs.rmSync(workerDest, { recursive: true });
fs.cpSync(workerSrc, workerDest, { recursive: true });
console.log('Copied tesseract worker src');

// 4. Download eng.traineddata.gz
const langDest = path.join(root, 'api', 'lang-data');
if (!fs.existsSync(langDest)) fs.mkdirSync(langDest, { recursive: true });
const langFile = path.join(langDest, 'eng.traineddata.gz');

if (fs.existsSync(langFile)) {
  console.log('eng.traineddata.gz already exists, skipping.');
  process.exit(0);
}

console.log('Downloading eng.traineddata.gz...');
const download = (url) => new Promise((resolve, reject) => {
  const file = fs.createWriteStream(langFile);
  https.get(url, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302) {
      file.close();
      return download(res.headers.location).then(resolve).catch(reject);
    }
    res.pipe(file);
    file.on('finish', () => { file.close(); resolve(); });
  }).on('error', (err) => { try { fs.unlinkSync(langFile); } catch(_){} reject(err); });
});

download('https://github.com/naptha/tessdata/blob/gh-pages/4.0.0/eng.traineddata.gz?raw=true')
  .then(() => console.log('✅ All files ready!'))
  .catch(err => { console.error('Download failed:', err); process.exit(1); });
