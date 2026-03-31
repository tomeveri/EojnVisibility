# EOJN Data Upload Guide

## Prerequisites

- Node.js installed
- `serviceAccountKey.json` in the `source/` folder
- Dependencies installed: run `npm install` in `source/`

## Upload New Data

1. Drop your ZIP files anywhere inside this `documentation/` folder (subfolders are fine)

2. Open PowerShell and run:

```powershell
cd c:\Users\tomev\Desktop\Eojn_visibility\source
node upload_to_firestore.js
```

The script automatically:
- Scans `documentation/` recursively for all ZIP files
- Skips files that have already been uploaded
- Uploads only new awards to Firestore

## Re-upload Everything (Fresh Start)

```powershell
cd c:\Users\tomev\Desktop\Eojn_visibility\source
node upload_to_firestore.js --clear
```

This deletes all existing data from Firestore and re-uploads everything.

## Redeploy Website

After uploading new data, the website updates automatically (it reads from Firestore).
If you changed `index.html`, redeploy with:

```powershell
cd c:\Users\tomev\Desktop\Eojn_visibility\source
firebase deploy
```

## Live Site

https://eojn-visibility.web.app
