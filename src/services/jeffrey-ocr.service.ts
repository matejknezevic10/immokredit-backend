// src/services/jeffrey-ocr.service.ts
//
// Jeffrey OCR Agent – Analysiert Dokumente mit Claude Vision
// und befüllt automatisch Kundenfelder (Person, Haushalt, Finanzplan, Objekt)
//

import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient } from '@prisma/client';
import { google } from 'googleapis';

const prisma = new PrismaClient();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ============================================================
// Google Drive client (reuse OAuth from googleDrive.service)
// ============================================================
function getGoogleDrive() {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google Drive OAuth2 not configured');
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth });
}

// ============================================================
// Download file from Google Drive as base64
// ============================================================
async function downloadFromGoogleDrive(googleDriveId: string): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const drive = getGoogleDrive();

    // Get file metadata
    const meta = await drive.files.get({
      fileId: googleDriveId,
      fields: 'id, name, mimeType',
    });

    const fileMimeType = meta.data.mimeType || 'application/octet-stream';
    console.log(`[Jeffrey OCR] Downloading from GDrive: ${meta.data.name} (${fileMimeType})`);

    // PDF — Claude Vision can't read PDFs directly, skip
    if (fileMimeType === 'application/pdf') {
      console.log(`[Jeffrey OCR] PDF detected — skipping (Claude Vision needs images)`);
      return null;
    }

    // Download file content
    const res = await drive.files.get(
      { fileId: googleDriveId, alt: 'media' },
      { responseType: 'arraybuffer' }
    );

    const buffer = Buffer.from(res.data as ArrayBuffer);
    const base64 = buffer.toString('base64');

    // Map to valid Claude Vision media type
    let visionMimeType = fileMimeType;
    if (visionMimeType === 'image/jpg') visionMimeType = 'image/jpeg';
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(visionMimeType)) {
      if (visionMimeType.startsWith('image/')) {
        visionMimeType = 'image/jpeg';
      } else {
        console.log(`[Jeffrey OCR] Unsupported type: ${visionMimeType}`);
        return null;
      }
    }

    console.log(`[Jeffrey OCR] ✅ Downloaded: ${buffer.length} bytes, type: ${visionMimeType}`);
    return { base64, mimeType: visionMimeType };
  } catch (err: any) {
    console.error(`[Jeffrey OCR] ❌ GDrive download failed:`, err.message);
    return null;
  }
}

// ============================================================
// Main: Process a document with Claude Vision
// ============================================================
export async function processDocumentOCR(documentId: string): Promise<{
  documentType: string;
  extractedFields: Record<string, any>;
  sectionsUpdated: string[];
  confidence: number;
}> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    include: { lead: true },
  });

  if (!doc) throw new Error('Dokument nicht gefunden');
  if (!doc.leadId) throw new Error('Dokument ist keinem Lead zugeordnet');

  console.log(`[Jeffrey OCR] Processing: ${doc.originalFilename} (type: ${doc.type}, driveId: ${doc.googleDriveId})`);

  await prisma.document.update({
    where: { id: documentId },
    data: { ocrStatus: 'PROCESSING' },
  });

  try {
    // Download from Google Drive
    let imageData: { base64: string; mimeType: string } | null = null;

    if (doc.googleDriveId) {
      imageData = await downloadFromGoogleDrive(doc.googleDriveId);
    }

    if (!imageData) {
      const reason = doc.googleDriveId ? 'Konnte nicht heruntergeladen werden (evtl. PDF)' : 'Keine Google Drive ID';
      console.log(`[Jeffrey OCR] ⚠️ Skipping ${doc.originalFilename}: ${reason}`);
      await prisma.document.update({
        where: { id: documentId },
        data: { ocrStatus: 'FAILED', ocrError: reason, ocrProcessedAt: new Date() },
      });
      return { documentType: doc.type, extractedFields: {}, sectionsUpdated: [], confidence: 0 };
    }

    // Send to Claude Vision
    const extractionResult = await analyzeWithClaude(imageData.base64, imageData.mimeType, doc.originalFilename, doc.type);

    // Save to customer fields
    const sectionsUpdated = await saveExtractedData(doc.leadId, extractionResult);

    // Update document
    await prisma.document.update({
      where: { id: documentId },
      data: {
        ocrStatus: 'COMPLETED',
        ocrProcessedAt: new Date(),
        ocrConfidence: extractionResult.confidence,
        extractedData: extractionResult as any,
      },
    });

    // Log activity
    await prisma.activity.create({
      data: {
        leadId: doc.leadId,
        type: 'DOCUMENT_OCR_COMPLETED',
        title: `Jeffrey: ${doc.originalFilename} analysiert`,
        description: `Typ: ${extractionResult.documentType}. ${countFields(extractionResult.fields)} Felder erkannt. Aktualisiert: ${sectionsUpdated.join(', ') || 'keine'}`,
        data: { documentId, sectionsUpdated, fieldCount: countFields(extractionResult.fields) } as any,
      },
    });

    console.log(`[Jeffrey OCR] ✅ Done: ${extractionResult.documentType}, ${countFields(extractionResult.fields)} fields, sections: ${sectionsUpdated.join(', ') || 'keine'}`);

    return {
      documentType: extractionResult.documentType,
      extractedFields: extractionResult.fields,
      sectionsUpdated,
      confidence: extractionResult.confidence,
    };

  } catch (err: any) {
    console.error(`[Jeffrey OCR] ❌ Error:`, err.message);
    await prisma.document.update({
      where: { id: documentId },
      data: { ocrStatus: 'FAILED', ocrError: err.message, ocrProcessedAt: new Date() },
    });
    throw err;
  }
}

function countFields(fields: Record<string, any>): number {
  let count = 0;
  for (const section of Object.values(fields)) {
    if (section && typeof section === 'object') {
      count += Object.keys(section).length;
    }
  }
  return count;
}

// ============================================================
// Analyze document with Claude Vision API
// ============================================================
interface ExtractionResult {
  documentType: string;
  confidence: number;
  fields: Record<string, any>;
  targetSections: string[];
}

async function analyzeWithClaude(
  imageBase64: string,
  mediaType: string,
  filename: string,
  existingType: string
): Promise<ExtractionResult> {

  const systemPrompt = `Du bist Jeffrey, ein spezialisierter OCR-Agent für die Immobilienfinanzierung in Österreich.
Du analysierst Dokumente und extrahierst strukturierte Daten daraus.

Antworte NUR mit validem JSON. Kein anderer Text, keine Erklärungen, kein Markdown.

Extrahiere je nach Dokumenttyp die passenden Felder:

REISEPASS / AUSWEIS → Person:
  vorname, nachname, geburtsdatum (YYYY-MM-DD), geburtsort, geburtsland, 
  staatsbuergerschaft, geschlecht (für anrede "Herr"/"Frau")

MELDEZETTEL → Person:
  strasse, hausnummer, stiege, top, plz, ort, land, wohnhaftSeit (YYYY-MM-DD)

GEHALTSABRECHNUNG / LOHNZETTEL → Person + Haushalt:
  Person: arbeitgeber, beruf, svNummer
  Haushalt: nettoverdienst (monatlich als Zahl)

ARBEITSVERTRAG → Person:
  arbeitgeber, beruf, anstellungsverhaeltnis, beschaeftigtSeit (YYYY-MM-DD)

GRUNDBUCHAUSZUG → Objekt:
  katastralgemeinde, einlagezahl, grundstuecksnummer, grundstuecksflaeche,
  strasse, hausnummer, plz, ort

ENERGIEAUSWEIS → Objekt:
  energiekennzahl

KAUFVERTRAG → Objekt + Finanzplan:
  Objekt: strasse, hausnummer, plz, ort, objektTyp
  Finanzplan: kaufpreis

KONTOAUSZUG → Person:
  kontoverbindung (IBAN)

JSON Format:
{
  "documentType": "REISEPASS",
  "confidence": 0.95,
  "targetSections": ["person"],
  "fields": {
    "person": { "vorname": "Max", "nachname": "Mustermann", "geburtsdatum": "1990-05-15", "geburtsort": "Wien", "geburtsland": "Österreich", "staatsbuergerschaft": "Österreich", "geschlecht": "männlich" },
    "haushalt": {},
    "finanzplan": {},
    "objekt": {}
  }
}

Wichtig:
- Lies JEDES Detail aus dem Bild das du erkennen kannst
- Nur Felder eintragen die du SICHER lesen kannst
- Bei Unsicherheit das Feld weglassen
- Zahlen als Nummern (nicht als String)
- Datumsfelder als "YYYY-MM-DD"
- confidence zwischen 0.0 und 1.0
- Leere sections als leeres Objekt {} lassen
- Achte besonders auf: Namen, Geburtsdaten, Adressen, SV-Nummern, Gehälter, IBANs`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: imageBase64,
            },
          },
          {
            type: 'text',
            text: `Analysiere dieses Dokument. Dateiname: "${filename}". Vorklassifiziert als: ${existingType}. Extrahiere ALLE erkennbaren Felder. Antworte NUR mit JSON.`,
          },
        ],
      },
    ],
  });

  const textContent = response.content.find((c: any) => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('Keine Text-Antwort von Claude');
  }

  let jsonStr = textContent.text.trim();
  jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  console.log(`[Jeffrey OCR] Claude response: ${jsonStr.substring(0, 300)}...`);

  try {
    return JSON.parse(jsonStr) as ExtractionResult;
  } catch {
    console.error('[Jeffrey OCR] Failed to parse:', jsonStr);
    throw new Error('Claude-Antwort konnte nicht geparst werden');
  }
}

// ============================================================
// Save extracted fields to CustomerPerson/Haushalt/Finanzplan/Objekt
// ============================================================
async function saveExtractedData(leadId: string, result: ExtractionResult): Promise<string[]> {
  const sectionsUpdated: string[] = [];
  const fields = result.fields;

  if (fields.person && Object.keys(fields.person).length > 0) {
    const data = sanitizePersonFields(fields.person);
    if (Object.keys(data).length > 0) {
      const existing = await prisma.customerPerson.findUnique({ where: { leadId } });
      if (existing) {
        const updates = getEmptyFieldUpdates(existing, data);
        if (Object.keys(updates).length > 0) {
          await prisma.customerPerson.update({ where: { leadId }, data: updates });
          sectionsUpdated.push(`Person (${Object.keys(updates).length} Felder)`);
        }
      } else {
        await prisma.customerPerson.create({ data: { leadId, ...data } });
        sectionsUpdated.push(`Person (${Object.keys(data).length} Felder)`);
      }
    }
  }

  if (fields.haushalt && Object.keys(fields.haushalt).length > 0) {
    const data = sanitizeHaushaltFields(fields.haushalt);
    if (Object.keys(data).length > 0) {
      const existing = await prisma.customerHaushalt.findUnique({ where: { leadId } });
      if (existing) {
        const updates = getEmptyFieldUpdates(existing, data);
        if (Object.keys(updates).length > 0) {
          await prisma.customerHaushalt.update({ where: { leadId }, data: updates });
          sectionsUpdated.push(`Haushalt (${Object.keys(updates).length} Felder)`);
        }
      } else {
        await prisma.customerHaushalt.create({ data: { leadId, ...data } });
        sectionsUpdated.push(`Haushalt (${Object.keys(data).length} Felder)`);
      }
    }
  }

  if (fields.finanzplan && Object.keys(fields.finanzplan).length > 0) {
    const data = sanitizeFinanzplanFields(fields.finanzplan);
    if (Object.keys(data).length > 0) {
      const existing = await prisma.customerFinanzplan.findUnique({ where: { leadId } });
      if (existing) {
        const updates = getEmptyFieldUpdates(existing, data);
        if (Object.keys(updates).length > 0) {
          await prisma.customerFinanzplan.update({ where: { leadId }, data: updates });
          sectionsUpdated.push(`Finanzplan (${Object.keys(updates).length} Felder)`);
        }
      } else {
        await prisma.customerFinanzplan.create({ data: { leadId, ...data } });
        sectionsUpdated.push(`Finanzplan (${Object.keys(data).length} Felder)`);
      }
    }
  }

  if (fields.objekt && Object.keys(fields.objekt).length > 0) {
    const data = sanitizeObjektFields(fields.objekt);
    if (Object.keys(data).length > 0) {
      const existing = await prisma.customerObjekt.findFirst({ where: { leadId } });
      if (existing) {
        const updates = getEmptyFieldUpdates(existing, data);
        if (Object.keys(updates).length > 0) {
          await prisma.customerObjekt.update({ where: { id: existing.id }, data: updates });
          sectionsUpdated.push(`Objekt (${Object.keys(updates).length} Felder)`);
        }
      } else {
        await prisma.customerObjekt.create({ data: { leadId, ...data } });
        sectionsUpdated.push(`Objekt (${Object.keys(data).length} Felder)`);
      }
    }
  }

  return sectionsUpdated;
}

function getEmptyFieldUpdates(existing: any, newData: Record<string, any>): Record<string, any> {
  const updates: Record<string, any> = {};
  for (const [key, value] of Object.entries(newData)) {
    if (value !== null && value !== undefined && value !== '') {
      const current = existing[key];
      if (current === null || current === undefined || current === '') {
        updates[key] = value;
      }
    }
  }
  return updates;
}

// ============================================================
// Field sanitizers
// ============================================================
function sanitizePersonFields(raw: any): Record<string, any> {
  const stringFields = [
    'anrede', 'titel', 'vorname', 'nachname',
    'strasse', 'hausnummer', 'stiege', 'top', 'plz', 'ort', 'land',
    'mobilnummer', 'telefon', 'email',
    'geburtsland', 'geburtsort', 'staatsbuergerschaft', 'weitereStaatsbuergerschaft',
    'svNummer', 'svTraeger',
    'wohnart', 'steuerdomizil', 'familienstand',
    'hoechsteAusbildung', 'anstellungsverhaeltnis',
    'beruf', 'arbeitgeber',
    'arbeitgeberStrasse', 'arbeitgeberHausnummer', 'arbeitgeberPlz', 'arbeitgeberOrt',
    'kontoverbindung', 'anmerkungen',
  ];
  const dateFields = ['geburtsdatum', 'wohnhaftSeit', 'beschaeftigtSeit'];
  const intFields = ['anzahlKinder', 'unterhaltsberechtigtePersonen', 'alterBeiLaufzeitende', 'vorbeschaeftigungsdauerMonate'];

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined || value === '') continue;
    if (stringFields.includes(key)) result[key] = String(value);
    else if (dateFields.includes(key)) {
      try { const d = new Date(String(value)); if (!isNaN(d.getTime())) result[key] = d; } catch {}
    } else if (intFields.includes(key)) {
      const num = parseInt(String(value)); if (!isNaN(num)) result[key] = num;
    }
  }
  if (raw.geschlecht && !result.anrede) {
    const g = String(raw.geschlecht).toLowerCase();
    if (g.includes('m') || g.includes('männ')) result.anrede = 'Herr';
    if (g.includes('w') || g.includes('weib') || g.includes('f')) result.anrede = 'Frau';
  }
  return result;
}

function sanitizeHaushaltFields(raw: any): Record<string, any> {
  const floatFields = [
    'betriebskostenMiete', 'energiekosten', 'telefonInternet', 'tvGebuehren',
    'transportkosten', 'versicherungen', 'lebenshaltungskostenKreditbeteiligte',
    'lebenshaltungskostenKinder', 'gesonderteAusgabenKinder', 'alimente',
    'summeEinnahmen', 'summeAusgaben', 'sicherheitsaufschlag', 'zwischensummeHhr',
    'freiVerfuegbaresEinkommen', 'bestandskrediteRate', 'rateFoerderung', 'zumutbareKreditrate',
  ];
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined || value === '') continue;
    if (floatFields.includes(key)) { const n = parseFloat(String(value)); if (!isNaN(n)) result[key] = n; }
    else if (key === 'argumentationEinkuenfte' || key === 'anmerkungen') result[key] = String(value);
  }
  if (raw.nettoverdienst) {
    const n = parseFloat(String(raw.nettoverdienst));
    if (!isNaN(n)) result.einkommen = [{ name: 'Kreditnehmer', nettoverdienst: n }];
  }
  return result;
}

function sanitizeFinanzplanFields(raw: any): Record<string, any> {
  const floatFields = [
    'kaufpreis', 'grundpreis', 'aufschliessungskosten', 'baukostenKueche',
    'renovierungskosten', 'summeProjektkosten', 'grunderwerbsteuer',
    'eigenmittelBar', 'summeEigenmittel', 'foerderung',
  ];
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined || value === '') continue;
    if (floatFields.includes(key)) { const n = parseFloat(String(value)); if (!isNaN(n)) result[key] = n; }
    else if (key === 'finanzierungszweck' || key === 'objektTyp' || key === 'anmerkungen') result[key] = String(value);
  }
  return result;
}

function sanitizeObjektFields(raw: any): Record<string, any> {
  const stringFields = ['objektTyp', 'katastralgemeinde', 'einlagezahl', 'grundstuecksnummer', 'strasse', 'hausnummer', 'plz', 'ort'];
  const floatFields = ['grundstuecksflaeche', 'energiekennzahl'];
  const intFields = ['baujahr'];
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined || value === '') continue;
    if (stringFields.includes(key)) result[key] = String(value);
    else if (floatFields.includes(key)) { const n = parseFloat(String(value)); if (!isNaN(n)) result[key] = n; }
    else if (intFields.includes(key)) { const n = parseInt(String(value)); if (!isNaN(n)) result[key] = n; }
  }
  return result;
}

// ============================================================
// Process all documents for a lead (resets status for re-analysis)
// ============================================================
export async function processAllDocumentsForLead(leadId: string): Promise<{
  processed: number;
  results: Array<{ documentId: string; filename: string; documentType: string; fieldsExtracted: number; sectionsUpdated: string[] }>;
}> {
  // Reset all to PENDING so they get re-analyzed
  await prisma.document.updateMany({
    where: { leadId },
    data: { ocrStatus: 'PENDING' },
  });

  const docs = await prisma.document.findMany({ where: { leadId } });
  console.log(`[Jeffrey OCR] Processing ${docs.length} documents for lead ${leadId}`);

  const results = [];
  for (const doc of docs) {
    try {
      const result = await processDocumentOCR(doc.id);
      results.push({
        documentId: doc.id,
        filename: doc.originalFilename,
        documentType: result.documentType,
        fieldsExtracted: countFields(result.extractedFields),
        sectionsUpdated: result.sectionsUpdated,
      });
    } catch (err: any) {
      console.error(`[Jeffrey OCR] Failed for ${doc.originalFilename}:`, err.message);
      results.push({ documentId: doc.id, filename: doc.originalFilename, documentType: 'FEHLER', fieldsExtracted: 0, sectionsUpdated: [] });
    }
  }

  return { processed: results.length, results };
}