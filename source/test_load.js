const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DATA_DIR = path.join(__dirname, '..', 'documentation', 'EOJN popis objava 01.01.2026 - 31.01.2026');
console.log('DATA_DIR:', DATA_DIR);
console.log('exists:', fs.existsSync(DATA_DIR));

const zips = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.zip'));
console.log('zip count:', zips.length);

const tmpDir = path.join(__dirname, '_tmp_extract');
if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir);

const zipPath = path.join(DATA_DIR, '02_01_2026.zip');
console.log('zipPath:', zipPath);

const cmd = `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force"`;
console.log('cmd:', cmd);

try {
  execSync(cmd, { stdio: 'pipe' });
  console.log('Extract OK');
} catch (err) {
  console.error('Extract FAILED:', err.message);
}

const xmlFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.xml'));
console.log('xml files:', xmlFiles);

if (xmlFiles.length > 0) {
  const content = fs.readFileSync(path.join(tmpDir, xmlFiles[0]), 'utf-8');
  console.log('xml length:', content.length);
  const m = content.match(/<Objava>/g);
  console.log('Objava tags:', m ? m.length : 0);

  // Test pattern from server
  const objavaRegex = /<Objava>([\s\S]*?)<\/Objava>/g;
  let count = 0;
  let match;
  while ((match = objavaRegex.exec(content)) !== null) {
    count++;
  }
  console.log('Objava regex matches:', count);
}

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });
