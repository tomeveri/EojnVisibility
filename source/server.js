const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, '..', 'documentation', 'EOJN popis objava 01.01.2026 - 31.01.2026');

// Extract text from an XML tag (first match)
function xmlVal(block, tag) {
  const m = block.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`));
  return m ? m[1].trim() : '';
}

// Extract a nested block
function xmlBlock(block, tag) {
  const m = block.match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`));
  return m ? m[1] : '';
}

// Parse XML to extract ALL notices with location info
function extractNotices(xml) {
  const notices = [];

  // Strip nested <VezaneObjave> sections to avoid matching inner <Objava> tags
  xml = xml.replace(/<VezaneObjave>[\s\S]*?<\/VezaneObjave>/g, '');

  const objavaRegex = /<Objava>([\s\S]*?)<\/Objava>/g;
  let objavaMatch;

  while ((objavaMatch = objavaRegex.exec(xml)) !== null) {
    const objavaXml = objavaMatch[1];

    // Contracting authority info
    const naruciteljBlock = xmlBlock(objavaXml, 'Narucitelj');
    const narucitelj = xmlVal(naruciteljBlock, 'Naziv');
    const naruciteljOib = xmlVal(naruciteljBlock, 'Oib');
    const naruciteljCity = xmlVal(naruciteljBlock, 'Mjesto');

    // Notice info
    const noticeId = xmlVal(objavaXml, 'Id');
    const oznaka = xmlVal(objavaXml, 'OznakaObjave');
    const vrsta = xmlVal(objavaXml, 'VrstaDokumenta');
    const datumObjave = xmlVal(objavaXml, 'DatumObjave');
    const urlObjave = xmlVal(objavaXml, 'UrlObjave');

    // Procedure info
    const predmet = xmlVal(objavaXml, 'PredmetNabave');
    const procijenjenaVrijednost = parseFloat(xmlVal(objavaXml, 'ProcijenjenaVrijednost')) || 0;
    const vrstaUgovora = xmlVal(objavaXml, 'VrstaUgovora');
    const vrstaPostupka = xmlVal(objavaXml, 'VrstaPostupka');

    // Extract contract awards from DodatniPodaci > SklapanjeUgovoraOkvirnogSporazuma
    const ugovorRegex = /<(?:UgovorOkvirniSporazumZaPredmetGrupu|UgovorOkvirniSporazum)\b[^>]*>([\s\S]*?)<\/(?:UgovorOkvirniSporazumZaPredmetGrupu|UgovorOkvirniSporazum)>/g;
    let ugovorMatch;
    let hasAwards = false;

    while ((ugovorMatch = ugovorRegex.exec(objavaXml)) !== null) {
      hasAwards = true;
      const ugovorXml = ugovorMatch[1];

      // Winning company details
      const gsBlock = xmlBlock(ugovorXml, 'GospdarskiSubjekt');
      const companyName = xmlVal(gsBlock, 'Naziv') || 'Unknown';
      const companyOib = xmlVal(gsBlock, 'Oib');
      const companyCity = xmlVal(gsBlock, 'Mjesto');

      // Contract amount
      const iznosMatch = ugovorXml.match(/<IznosSklopljenogUgovoraOSSPdv>([\d.,]+)<\/IznosSklopljenogUgovoraOSSPdv>/);
      const amount = iznosMatch ? parseFloat(iznosMatch[1]) : 0;

      const datumSklapanja = xmlVal(ugovorXml, 'DatumSklapanjaUgovora');

      notices.push({
        companyName,
        companyOib,
        companyCity,
        amount,
        narucitelj,
        naruciteljOib,
        naruciteljCity,
        predmet,
        vrsta,
        vrstaUgovora,
        vrstaPostupka,
        procijenjenaVrijednost,
        noticeId,
        oznaka,
        datumObjave,
        datumSklapanja,
        urlObjave
      });
    }

    // If no contract awards found, still record the notice (for non-award types)
    if (!hasAwards) {
      notices.push({
        companyName: null,
        companyOib: null,
        companyCity: null,
        amount: 0,
        narucitelj,
        naruciteljOib,
        naruciteljCity,
        predmet,
        vrsta,
        vrstaUgovora,
        vrstaPostupka,
        procijenjenaVrijednost,
        noticeId,
        oznaka,
        datumObjave,
        datumSklapanja: null,
        urlObjave
      });
    }
  }

  return notices;
}

// Load and parse all ZIP data at startup
let allNotices = [];

function loadData() {
  console.log('Loading EOJN data from ZIP files...');

  if (!fs.existsSync(DATA_DIR)) {
    console.error('Data directory not found:', DATA_DIR);
    return;
  }

  const zipFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.zip')).sort();
  const tmpDir = path.join(__dirname, '_tmp_extract');

  for (const zipFile of zipFiles) {
    const zipPath = path.join(DATA_DIR, zipFile);

    // Clean tmp dir
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tmpDir);

    try {
      // Extract ZIP using PowerShell
      execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force"`, { stdio: 'pipe' });

      // Read extracted XML
      const xmlFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.xml'));
      for (const xmlFile of xmlFiles) {
        const xmlContent = fs.readFileSync(path.join(tmpDir, xmlFile), 'utf-8');
        const notices = extractNotices(xmlContent);
        allNotices.push(...notices);
      }
    } catch (err) {
      console.error(`Error processing ${zipFile}:`, err.message);
    }
  }

  // Cleanup
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const awards = allNotices.filter(n => n.companyName);
  console.log(`Loaded ${allNotices.length} notices, ${awards.length} contract awards`);
}

// Award notice types
const AWARD_TYPES = [
  'ObavijestOSklopljenimUgovorima',
  'ObavijestOSkopljenimUgovorimaSektor',
  'SklopljenUgovorBagatelnaNabava',
  'ObavijeODodjeliUgovoraRezultatiPostupka',
  'ObavijestODodjeliUgovoraRezultatiPostupkaSektorskaNabava',
  'ObavijestOIzmjeniUgovoraTijekomTrajanjaJavnaNabava',
  'ObavijestOIzmjeniUgovoraTijekomTrajanjaSektorskaNabava'
];

function cityMatches(city, target) {
  if (!city || !target) return false;
  return city.toLowerCase().includes(target.toLowerCase());
}

// API endpoint
app.get('/api/tenders', (req, res) => {
  const { city } = req.query;

  // Only notices that have a company (i.e. contract awards)
  const awards = allNotices.filter(n => n.companyName);

  // Filter by company city
  let filtered = awards;
  if (city) {
    filtered = awards.filter(a => cityMatches(a.companyCity, city));
  }

  // Aggregate by company (OIB as key if available, else name)
  const companyMap = {};
  for (const award of filtered) {
    const key = award.companyOib || award.companyName;
    if (!companyMap[key]) {
      companyMap[key] = {
        companyName: award.companyName,
        companyOib: award.companyOib,
        companyCity: award.companyCity,
        tenderCount: 0,
        totalAmount: 0,
        tenders: []
      };
    }
    companyMap[key].tenderCount++;
    companyMap[key].totalAmount += award.amount;
    if (award.companyCity && !companyMap[key].companyCity) {
      companyMap[key].companyCity = award.companyCity;
    }
    companyMap[key].tenders.push({
      narucitelj: award.narucitelj,
      predmet: award.predmet,
      amount: award.amount,
      datumObjave: award.datumObjave,
      datumSklapanja: award.datumSklapanja,
      vrstaUgovora: award.vrstaUgovora,
      urlObjave: award.urlObjave
    });
  }

  const companies = Object.values(companyMap).sort((a, b) => b.totalAmount - a.totalAmount);

  // Get all unique cities for the filter dropdown
  const cities = [...new Set(awards.map(a => a.companyCity).filter(Boolean))].sort();

  res.json({
    period: 'January 2026',
    cityFilter: city || null,
    totalAwardsAll: awards.length,
    totalAwards: filtered.length,
    totalAmount: filtered.reduce((s, a) => s + a.amount, 0),
    cities,
    companies
  });
});

// Load data then start server
loadData();

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
