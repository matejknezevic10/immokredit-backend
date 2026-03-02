// src/services/jeffrey-ocr.service.ts
//
// Jeffrey OCR Agent – Analysiert Dokumente mit Claude Vision
// und befüllt automatisch Kundenfelder (Person, Haushalt, Finanzplan, Objekt)
//

import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ============================================================
// Document type → which customer section it maps to
// ============================================================
const DOC_TYPE_MAPPING: Record<string, string[]> = {
  REISEPASS: ['person'],
  AUSWEIS: ['person'],
  MELDEZETTEL: ['person'],
  GEHALTSABRECHNUNG: ['person', 'haushalt'],
  STEUERBESCHEID: ['haushalt'],
  ARBEITSVERTRAG: ['person'],
  GRUNDBUCHAUSZUG: ['objekt'],
  ENERGIEAUSWEIS: ['objekt'],
  KAUFVERTRAG: ['objekt', 'finanzplan'],
  EXPOSE: ['objekt'],
  KONTOAUSZUG: ['haushalt'],
  SONSTIGES: [],
};

// ============================================================
// Main: Process a document with Claude Vision
// ============================================================
export async function processDocumentOCR(documentId: string): Promise<{
  documentType: string;
  extractedFields: Record<string, any>;
  sectionsUpdated: string[];
  confidence: number;
}> {
  // 1. Load document from DB
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    include: { lead: true },
  });

  if (!doc) throw new Error('Dokument nicht gefunden');
  if (!doc.leadId) throw new Error('Dokument ist keinem Lead zugeordnet');

  console.log(`[Jeffrey OCR] Processing document: ${doc.originalFilename} for lead ${doc.leadId}`);

  // 2. Update status
  await prisma.document.update({
    where: { id: documentId },
    data: { ocrStatus: 'PROCESSING' },
  });

  try {
    // 3. Get document content (from Google Drive URL or local)
    let imageData: string | null = null;
    let mediaType: string = 'image/jpeg';

    // Try to fetch from Google Drive if URL exists
    if (doc.googleDriveUrl) {
      imageData = await fetchImageAsBase64(doc.googleDriveUrl);
    }

    // If no image data, try to read from local filesystem
    if (!imageData && doc.filename) {
      const localPath = path.join(process.cwd(), 'uploads', doc.filename);
      if (fs.existsSync(localPath)) {
        const buffer = fs.readFileSync(localPath);
        imageData = buffer.toString('base64');
        mediaType = doc.mimeType || 'image/jpeg';
      }
    }

    // 4. Send to Claude Vision for analysis
    const extractionResult = await analyzeWithClaude(imageData, mediaType, doc.originalFilename, doc.type);

    // 5. Save extracted data to customer fields
    const sectionsUpdated = await saveExtractedData(doc.leadId, extractionResult);

    // 6. Update document status
    await prisma.document.update({
      where: { id: documentId },
      data: {
        ocrStatus: 'COMPLETED',
        ocrProcessedAt: new Date(),
        ocrConfidence: extractionResult.confidence,
        extractedData: extractionResult as any,
      },
    });

    // 7. Log activity
    await prisma.activity.create({
      data: {
        leadId: doc.leadId,
        type: 'DOCUMENT_OCR_COMPLETED',
        title: `Jeffrey: ${doc.originalFilename} analysiert`,
        description: `Dokumenttyp: ${extractionResult.documentType}. ${Object.keys(extractionResult.fields).length} Felder erkannt. Aktualisiert: ${sectionsUpdated.join(', ')}`,
        data: { documentId, extractedFields: Object.keys(extractionResult.fields) } as any,
      },
    });

    console.log(`[Jeffrey OCR] ✅ Done: ${extractionResult.documentType}, ${Object.keys(extractionResult.fields).length} fields, sections: ${sectionsUpdated.join(', ')}`);

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
      data: {
        ocrStatus: 'FAILED',
        ocrError: err.message,
        ocrProcessedAt: new Date(),
      },
    });
    throw err;
  }
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
  imageBase64: string | null,
  mediaType: string,
  filename: string,
  existingType: string
): Promise<ExtractionResult> {

  const systemPrompt = `Du bist Jeffrey, ein spezialisierter OCR-Agent für die Immobilienfinanzierung in Österreich.
Du analysierst Dokumente und extrahierst strukturierte Daten daraus.

Antworte NUR mit validem JSON. Kein anderer Text.

Extrahiere je nach Dokumenttyp die passenden Felder:

REISEPASS / AUSWEIS → Person:
  vorname, nachname, geburtsdatum (YYYY-MM-DD), geburtsort, geburtsland, 
  staatsbuergerschaft, geschlecht (für anrede "Herr"/"Frau")

MELDEZETTEL → Person:
  strasse, hausnummer, stiege, top, plz, ort, land, wohnhaftSeit (YYYY-MM-DD)

GEHALTSABRECHNUNG / LOHNZETTEL → Person + Haushalt:
  Person: arbeitgeber, beruf, svNummer
  Haushalt: nettoverdienst (Zahl), bruttogehalt (Zahl)

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

EXPOSE → Objekt:
  objektTyp, strasse, hausnummer, plz, ort, 
  flaecheErdgeschoss, flaecheKeller, flaecheObergeschoss, baujahr

KONTOAUSZUG → Person + Haushalt:
  Person: kontoverbindung (IBAN)

JSON Format:
{
  "documentType": "REISEPASS",
  "confidence": 0.95,
  "targetSections": ["person"],
  "fields": {
    "person": { "vorname": "Max", "nachname": "Mustermann", ... },
    "haushalt": { ... },
    "finanzplan": { ... },
    "objekt": { ... }
  }
}

Wichtig:
- Nur Felder eintragen die du SICHER erkannt hast
- Bei Unsicherheit das Feld weglassen
- Zahlen als Nummern, nicht als Strings
- Datumsfelder als "YYYY-MM-DD"
- confidence zwischen 0.0 und 1.0
- Leere sections weglassen`;

  const messages: any[] = [];

  if (imageBase64) {
    // Ensure correct media type for Claude
    let validMediaType = mediaType;
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(validMediaType)) {
      // For PDFs, we'll send as text-based description
      if (validMediaType === 'application/pdf') {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analysiere dieses Dokument. Dateiname: "${filename}". Bereits klassifiziert als: ${existingType}. Das Dokument ist ein PDF das ich dir nicht als Bild zeigen kann. Bitte extrahiere basierend auf dem Dokumenttyp und dem Dateinamen was du kannst. Antworte NUR mit JSON.`,
            },
          ],
        });
      } else {
        validMediaType = 'image/jpeg'; // fallback
      }
    }

    if (messages.length === 0) {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: validMediaType,
              data: imageBase64,
            },
          },
          {
            type: 'text',
            text: `Analysiere dieses Dokument. Dateiname: "${filename}". Bereits klassifiziert als: ${existingType}. Extrahiere alle erkennbaren Felder. Antworte NUR mit JSON.`,
          },
        ],
      });
    }
  } else {
    // No image — just use filename and type
    messages.push({
      role: 'user',
      content: `Ich habe ein Dokument mit dem Namen "${filename}" vom Typ "${existingType}". Ich kann dir kein Bild zeigen. Antworte mit einem leeren JSON: {"documentType": "${existingType}", "confidence": 0.1, "targetSections": [], "fields": {}}`,
    });
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: systemPrompt,
    messages,
  });

  // Parse response
  const textContent = response.content.find((c: any) => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('Keine Text-Antwort von Claude');
  }

  let jsonStr = textContent.text.trim();
  // Remove potential markdown code fences
  jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  try {
    const result = JSON.parse(jsonStr) as ExtractionResult;
    return result;
  } catch (parseErr) {
    console.error('[Jeffrey OCR] Failed to parse Claude response:', jsonStr);
    throw new Error('Claude-Antwort konnte nicht geparst werden');
  }
}

// ============================================================
// Save extracted fields to CustomerPerson/Haushalt/Finanzplan/Objekt
// ============================================================
async function saveExtractedData(leadId: string, result: ExtractionResult): Promise<string[]> {
  const sectionsUpdated: string[] = [];
  const fields = result.fields;

  // ── Person ──
  if (fields.person && Object.keys(fields.person).length > 0) {
    const personData = sanitizePersonFields(fields.person);
    const existing = await prisma.customerPerson.findUnique({ where: { leadId } });
    if (existing) {
      // Only update fields that are currently empty/null
      const updates: Record<string, any> = {};
      for (const [key, value] of Object.entries(personData)) {
        if (value !== null && value !== undefined && value !== '') {
          const currentVal = (existing as any)[key];
          if (currentVal === null || currentVal === undefined || currentVal === '') {
            updates[key] = value;
          }
        }
      }
      if (Object.keys(updates).length > 0) {
        await prisma.customerPerson.update({ where: { leadId }, data: updates });
        sectionsUpdated.push('Person');
      }
    } else {
      await prisma.customerPerson.create({ data: { leadId, ...personData } });
      sectionsUpdated.push('Person');
    }
  }

  // ── Haushalt ──
  if (fields.haushalt && Object.keys(fields.haushalt).length > 0) {
    const haushaltData = sanitizeHaushaltFields(fields.haushalt);
    const existing = await prisma.customerHaushalt.findUnique({ where: { leadId } });
    if (existing) {
      const updates: Record<string, any> = {};
      for (const [key, value] of Object.entries(haushaltData)) {
        if (value !== null && value !== undefined && value !== '') {
          const currentVal = (existing as any)[key];
          if (currentVal === null || currentVal === undefined || currentVal === '') {
            updates[key] = value;
          }
        }
      }
      if (Object.keys(updates).length > 0) {
        await prisma.customerHaushalt.update({ where: { leadId }, data: updates });
        sectionsUpdated.push('Haushalt');
      }
    } else {
      await prisma.customerHaushalt.create({ data: { leadId, ...haushaltData } });
      sectionsUpdated.push('Haushalt');
    }
  }

  // ── Finanzplan ──
  if (fields.finanzplan && Object.keys(fields.finanzplan).length > 0) {
    const fpData = sanitizeFinanzplanFields(fields.finanzplan);
    const existing = await prisma.customerFinanzplan.findUnique({ where: { leadId } });
    if (existing) {
      const updates: Record<string, any> = {};
      for (const [key, value] of Object.entries(fpData)) {
        if (value !== null && value !== undefined && value !== '') {
          const currentVal = (existing as any)[key];
          if (currentVal === null || currentVal === undefined || currentVal === '') {
            updates[key] = value;
          }
        }
      }
      if (Object.keys(updates).length > 0) {
        await prisma.customerFinanzplan.update({ where: { leadId }, data: updates });
        sectionsUpdated.push('Finanzplan');
      }
    } else {
      await prisma.customerFinanzplan.create({ data: { leadId, ...fpData } });
      sectionsUpdated.push('Finanzplan');
    }
  }

  // ── Objekt ──
  if (fields.objekt && Object.keys(fields.objekt).length > 0) {
    const objektData = sanitizeObjektFields(fields.objekt);
    // Find first existing objekt or create new
    const existing = await prisma.customerObjekt.findFirst({ where: { leadId } });
    if (existing) {
      const updates: Record<string, any> = {};
      for (const [key, value] of Object.entries(objektData)) {
        if (value !== null && value !== undefined && value !== '') {
          const currentVal = (existing as any)[key];
          if (currentVal === null || currentVal === undefined || currentVal === '') {
            updates[key] = value;
          }
        }
      }
      if (Object.keys(updates).length > 0) {
        await prisma.customerObjekt.update({ where: { id: existing.id }, data: updates });
        sectionsUpdated.push('Objekt');
      }
    } else {
      await prisma.customerObjekt.create({ data: { leadId, ...objektData } });
      sectionsUpdated.push('Objekt');
    }
  }

  return sectionsUpdated;
}

// ============================================================
// Field sanitizers — ensure correct types for Prisma
// ============================================================
function sanitizePersonFields(raw: any): Record<string, any> {
  const allowed = [
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

    if (allowed.includes(key)) {
      result[key] = String(value);
    } else if (dateFields.includes(key)) {
      try { result[key] = new Date(String(value)); } catch {}
    } else if (intFields.includes(key)) {
      const num = parseInt(String(value));
      if (!isNaN(num)) result[key] = num;
    }
  }

  // Map geschlecht → anrede
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
  const stringFields = ['argumentationEinkuenfte', 'anmerkungWohnkosten', 'anmerkungen'];

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined || value === '') continue;
    if (floatFields.includes(key)) {
      const num = parseFloat(String(value));
      if (!isNaN(num)) result[key] = num;
    } else if (stringFields.includes(key)) {
      result[key] = String(value);
    }
  }

  // Handle nettoverdienst → store in einkommen JSON
  if (raw.nettoverdienst) {
    result.einkommen = [{ name: 'Kreditnehmer', nettoverdienst: parseFloat(String(raw.nettoverdienst)) }];
  }

  return result;
}

function sanitizeFinanzplanFields(raw: any): Record<string, any> {
  const floatFields = [
    'kaufpreis', 'grundpreis', 'aufschliessungskosten', 'baukostenKueche',
    'renovierungskosten', 'baukostenueberschreitung', 'kaufnebenkostenProjekt',
    'moebelSonstiges', 'summeProjektkosten',
    'kaufvertragTreuhandProzent', 'maklergebuehrProzent',
    'grunderwerbsteuer', 'eintragungEigentumsrecht', 'errichtungKaufvertragTreuhand',
    'maklergebuehr', 'summeKaufnebenkosten',
    'eigenmittelBar', 'verkaufserloese', 'abloesekapitalVersicherung', 'bausparguthaben', 'summeEigenmittel',
    'foerderung', 'sonstigeMittel',
    'zwischenfinanzierungNetto', 'zwischenfinanzierungBrutto',
    'langfrFinanzierungsbedarfNetto', 'finanzierungsnebenkosten', 'langfrFinanzierungsbedarfBrutto',
  ];
  const stringFields = ['finanzierungszweck', 'objektTyp', 'anmerkungen'];

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined || value === '') continue;
    if (floatFields.includes(key)) {
      const num = parseFloat(String(value));
      if (!isNaN(num)) result[key] = num;
    } else if (stringFields.includes(key)) {
      result[key] = String(value);
    }
  }
  return result;
}

function sanitizeObjektFields(raw: any): Record<string, any> {
  const stringFields = [
    'objektTyp', 'zugehoerigkeitKreditnehmer',
    'katastralgemeinde', 'einlagezahl', 'grundstuecksnummer',
    'strasse', 'hausnummer', 'plz', 'ort',
    'materialanteil', 'orientierung',
    'treuhaenderName', 'treuhaenderTelefon', 'treuhaenderFax',
    'treuhaenderStrasse', 'treuhaenderHausnummer', 'treuhaenderPlz', 'treuhaenderOrt',
  ];
  const floatFields = [
    'grundstuecksflaeche', 'energiekennzahl',
    'flaecheKeller', 'flaecheErdgeschoss', 'flaecheObergeschoss',
    'flaecheWeiteresOg', 'flaecheDachgeschoss',
    'flaecheLoggia', 'flaecheBalkon', 'flaecheTerrasse',
    'flaecheWintergarten', 'flaecheGarage', 'flaecheNebengebaeude',
  ];
  const intFields = ['baujahr'];
  const boolFields = ['geplanteVermietung', 'objektImBau', 'fertigteilbauweise'];

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined || value === '') continue;
    if (stringFields.includes(key)) result[key] = String(value);
    else if (floatFields.includes(key)) {
      const num = parseFloat(String(value));
      if (!isNaN(num)) result[key] = num;
    }
    else if (intFields.includes(key)) {
      const num = parseInt(String(value));
      if (!isNaN(num)) result[key] = num;
    }
    else if (boolFields.includes(key)) {
      result[key] = value === true || value === 'true' || value === 'ja' || value === 'Ja';
    }
  }
  return result;
}

// ============================================================
// Helper: Fetch image from URL as base64
// ============================================================
async function fetchImageAsBase64(url: string): Promise<string | null> {
  try {
    // For Google Drive, convert to direct download URL
    let fetchUrl = url;
    const driveMatch = url.match(/\/d\/([^/]+)/);
    if (driveMatch) {
      fetchUrl = `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
    }

    const res = await fetch(fetchUrl);
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
  } catch {
    return null;
  }
}

// ============================================================
// Process all unprocessed documents for a lead
// ============================================================
export async function processAllDocumentsForLead(leadId: string): Promise<{
  processed: number;
  results: Array<{ documentId: string; filename: string; documentType: string; fieldsExtracted: number }>;
}> {
  const docs = await prisma.document.findMany({
    where: {
      leadId,
      ocrStatus: { in: ['PENDING', 'FAILED'] },
    },
  });

  const results = [];
  for (const doc of docs) {
    try {
      const result = await processDocumentOCR(doc.id);
      results.push({
        documentId: doc.id,
        filename: doc.originalFilename,
        documentType: result.documentType,
        fieldsExtracted: Object.keys(result.extractedFields).length,
      });
    } catch (err: any) {
      console.error(`[Jeffrey OCR] Failed for ${doc.originalFilename}:`, err.message);
    }
  }

  return { processed: results.length, results };
}