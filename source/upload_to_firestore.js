const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// =============================================================
// Firebase Admin Setup
// Download your service account key from Firebase Console:
//   Project Settings > Service Accounts > Generate New Private Key
// Save the file as 'serviceAccountKey.json' in this directory
// =============================================================
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// --- Data folder ---
// Drop ZIP files anywhere inside documentation/ (including subfolders)
// The script finds them all automatically and tracks what's been uploaded
const DOCS_DIR = path.join(__dirname, '..', 'documentation');

function findZipsRecursive(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findZipsRecursive(fullPath));
    } else if (entry.name.endsWith('.zip')) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

// --- XML Parsing (same logic as server.js) ---

function xmlVal(block, tag) {
  const m = block.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`));
  return m ? m[1].trim() : '';
}

function xmlBlock(block, tag) {
  const m = block.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`));
  return m ? m[1] : '';
}

function normalizeCity(city) {
  if (!city) return '';
  return city.trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function extractAwards(xml) {
  const awards = [];
  xml = xml.replace(/<VezaneObjave>[\s\S]*?<\/VezaneObjave>/g, '');
  const objavaRegex = /<Objava>([\s\S]*?)<\/Objava>/g;
  let objavaMatch;

  while ((objavaMatch = objavaRegex.exec(xml)) !== null) {
    const objavaXml = objavaMatch[1];

    const naruciteljBlock = xmlBlock(objavaXml, 'Narucitelj');
    const narucitelj = xmlVal(naruciteljBlock, 'Naziv');
    const naruciteljOib = xmlVal(naruciteljBlock, 'Oib');
    const naruciteljCity = normalizeCity(xmlVal(naruciteljBlock, 'Mjesto'));

    const noticeId = xmlVal(objavaXml, 'Id');
    const oznaka = xmlVal(objavaXml, 'OznakaObjave');
    const vrsta = xmlVal(objavaXml, 'VrstaDokumenta');
    const datumObjave = xmlVal(objavaXml, 'DatumObjave');
    const urlObjave = xmlVal(objavaXml, 'UrlObjave');
    const predmet = xmlVal(objavaXml, 'PredmetNabave');
    const procijenjenaVrijednost = parseFloat(xmlVal(objavaXml, 'ProcijenjenaVrijednost')) || 0;
    const vrstaUgovora = xmlVal(objavaXml, 'VrstaUgovora');
    const vrstaPostupka = xmlVal(objavaXml, 'VrstaPostupka');

    const ugovorRegex = /<(?:UgovorOkvirniSporazumZaPredmetGrupu|UgovorOkvirniSporazum)\b[^>]*>([\s\S]*?)<\/(?:UgovorOkvirniSporazumZaPredmetGrupu|UgovorOkvirniSporazum)>/g;
    let ugovorMatch;

    while ((ugovorMatch = ugovorRegex.exec(objavaXml)) !== null) {
      const ugovorXml = ugovorMatch[1];
      const gsBlock = xmlBlock(ugovorXml, 'GospdarskiSubjekt');
      const companyName = xmlVal(gsBlock, 'Naziv') || 'Unknown';
      const companyOib = xmlVal(gsBlock, 'Oib');
      const companyCity = normalizeCity(xmlVal(gsBlock, 'Mjesto'));
      const iznosMatch = ugovorXml.match(/<IznosSklopljenogUgovoraOSSPdv>([\d.,]+)<\/IznosSklopljenogUgovoraOSSPdv>/);
      const amount = iznosMatch ? parseFloat(iznosMatch[1]) : 0;
      const datumSklapanja = xmlVal(ugovorXml, 'DatumSklapanjaUgovora');

      awards.push({
        companyName, companyOib, companyCity, amount,
        narucitelj, naruciteljOib, naruciteljCity,
        predmet, vrsta, vrstaUgovora, vrstaPostupka, procijenjenaVrijednost,
        noticeId, oznaka, datumObjave, datumSklapanja, urlObjave
      });
    }
  }

  return awards;
}

// --- Firestore Batch Write (respects 500 ops/batch limit) ---
async function writeBatch(docs, collectionName) {
  const BATCH_SIZE = 400;
  let written = 0;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = docs.slice(i, i + BATCH_SIZE);

    for (const doc of chunk) {
      const ref = db.collection(collectionName).doc();
      batch.set(ref, doc);
    }

    await batch.commit();
    written += chunk.length;
    process.stdout.write(`\r  Written ${written}/${docs.length}`);
  }
  console.log();
  return written;
}

async function writeBatchSilent(docs, collectionName) {
  const BATCH_SIZE = 400;
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = docs.slice(i, i + BATCH_SIZE);
    for (const doc of chunk) {
      const ref = db.collection(collectionName).doc();
      batch.set(ref, doc);
    }
    await batch.commit();
  }
}

// --- Main ---
async function main() {
  const clearFlag = process.argv.includes('--clear');

  if (clearFlag) {
    console.log('Clearing all existing awards from Firestore...');
    // Delete in pages to avoid loading everything into memory
    let deleted = 0;
    while (true) {
      const snapshot = await db.collection('awards').limit(400).get();
      if (snapshot.empty) break;
      const batch = db.batch();
      snapshot.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      deleted += snapshot.size;
      process.stdout.write(`\r  Deleted ${deleted} documents...`);
    }
    await db.collection('metadata').doc('upload_log').delete();
    console.log(`\nDeleted ${deleted} awards. Starting fresh.\n`);
  }

  console.log('EOJN Data Uploader -> Firestore\n');

  const metaRef = db.collection('metadata').doc('upload_log');
  const metaSnap = await metaRef.get();
  let processedFiles = metaSnap.exists ? (metaSnap.data().processedFiles || []) : [];
  let allCities = metaSnap.exists ? (metaSnap.data().cities || []) : [];
  let totalAwards = metaSnap.exists ? (metaSnap.data().totalAwards || 0) : 0;

  const tmpDir = path.join(__dirname, '_tmp_extract');

  const allZips = findZipsRecursive(DOCS_DIR);

  if (allZips.length === 0) {
    console.log(`No ZIP files found in ${DOCS_DIR}`);
    return;
  }

  const newZips = allZips.filter(z => {
    const relPath = path.relative(DOCS_DIR, z);
    return !processedFiles.includes(relPath);
  });

  if (newZips.length === 0) {
    console.log(`All ${allZips.length} ZIP files already uploaded. Nothing new.`);
    return;
  }

  console.log(`Found ${allZips.length} total ZIPs, ${newZips.length} new to upload.\n`);

  let uploadedTotal = 0;

  for (const zipPath of newZips) {
    const relPath = path.relative(DOCS_DIR, zipPath);

    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir);

    try {
      execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force"`, { stdio: 'pipe' });

      let zipAwards = [];
      const xmlFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.xml'));
      for (const xmlFile of xmlFiles) {
        const xmlContent = fs.readFileSync(path.join(tmpDir, xmlFile), 'utf-8');
        const awards = extractAwards(xmlContent);
        zipAwards.push(...awards.map(a => ({ ...a, sourceFile: relPath })));
      }

      // Upload this ZIP's awards immediately (don't accumulate in memory)
      if (zipAwards.length > 0) {
        await writeBatchSilent(zipAwards, 'awards');
        uploadedTotal += zipAwards.length;

        // Merge cities
        const newCities = [...new Set(zipAwards.map(a => a.naruciteljCity).filter(Boolean))];
        allCities = [...new Set([...allCities, ...newCities])].sort();
      }

      // Track this file as processed
      processedFiles.push(relPath);
      totalAwards += zipAwards.length;

      // Update metadata after each ZIP (so progress is saved if interrupted)
      await metaRef.set({
        processedFiles,
        cities: allCities,
        totalAwards,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log(`  ${relPath} -> ${zipAwards.length} awards (total: ${uploadedTotal})`);
    } catch (err) {
      console.error(`  Error processing ${relPath}: ${err.message}`);
    }
  }

  // Cleanup tmp
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\nDone! Uploaded ${uploadedTotal} new awards.`);
  console.log(`Total awards in Firestore: ${totalAwards}`);
  console.log(`Cities: ${allCities.length}`);
}

main().catch(console.error).then(() => process.exit());
