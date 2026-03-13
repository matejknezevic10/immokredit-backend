// src/services/jeffrey-ocr.service.ts
//
// Jeffrey OCR Agent – Analysiert Dokumente mit Claude Vision
// und befüllt automatisch Kundenfelder (Person, Haushalt, Finanzplan, Objekt)
//
// Verbesserungen v2:
// - PDF-Support via Claude Document API
// - Dokumenttyp-spezifische Prompts für bessere Erkennung
// - Automatische Re-Klassifizierung falscher Dokumenttypen
// - Erweiterte Field-Sanitizer für alle Prisma-Schema-Felder
// - STEUERBESCHEID, MELDEZETTEL, EXPOSE, ENERGIEAUSWEIS Support
//

import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient } from '@prisma/client';
import { google } from 'googleapis';

const prisma = new PrismaClient() as any;

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
// Document-type specific extraction prompts
// ============================================================
const DOCUMENT_TYPE_PROMPTS: Record<string, string> = {
  REISEPASS: `Analysiere diesen REISEPASS. Extrahiere:
- vorname, nachname: EXAKT aus dem Pass ablesen
- geburtsdatum: Format YYYY-MM-DD
- geburtsort, geburtsland
- staatsbuergerschaft
- geschlecht: "männlich" oder "weiblich"
- passnummer (falls lesbar)
- Lies auch die MRZ (Machine Readable Zone) unten falls vorhanden
Felder → person section`,

  AUSWEIS: `Analysiere diesen PERSONALAUSWEIS / AUFENTHALTSTITEL. Extrahiere:
- vorname, nachname: EXAKT ablesen
- geburtsdatum: Format YYYY-MM-DD
- geburtsort, geburtsland
- staatsbuergerschaft
- geschlecht: "männlich" oder "weiblich"
- ausweisnummer (falls lesbar)
- Adresse falls auf dem Ausweis angegeben (strasse, hausnummer, plz, ort)
Felder → person section`,

  MELDEZETTEL: `Analysiere diesen MELDEZETTEL. Extrahiere:
- vorname, nachname: EXAKT ablesen
- strasse, hausnummer, stiege, top, plz, ort, land
- wohnhaftSeit: Datum des Einzugs (YYYY-MM-DD)
- geburtsdatum (YYYY-MM-DD, falls angegeben)
- staatsbuergerschaft (falls angegeben)
- familienstand (falls angegeben)
Felder → person section`,

  GEHALTSABRECHNUNG: `Analysiere diesen LOHNZETTEL / GEHALTSABRECHNUNG / L16.
WICHTIG für österreichische Lohnzettel:
- arbeitnehmer_name: Steht unter "Arbeitnehmer*in" – lies den EXAKTEN Namen
- arbeitgeber: Firmenname (oft unten mit Adresse), NICHT Kürzel wie "MBA"
- brutto_gehalt: Zeile (210) "Bruttobezüge gemäß §25" = Jahresbrutto. Bei Monatslohnzettel das Monatsbrutto
- netto_gehalt: Monatsgehalt netto, falls angegeben
- svNummer: 10-stellige Sozialversicherungsnummer, oft oben rechts ("Vers.-Nr.")
- abrechnungsmonat: Der Zeitraum "vom ... bis ..."
- beruf: Berufsbezeichnung falls angegeben
- beschaeftigtSeit: Eintrittsdatum falls angegeben (YYYY-MM-DD)
Extrahiere vorname + nachname getrennt aus dem Arbeitnehmernamen.
Felder → person + haushalt sections`,

  STEUERBESCHEID: `Analysiere diesen STEUERBESCHEID / EINKOMMENSTEUERBESCHEID.
Extrahiere:
- vorname, nachname des Steuerpflichtigen
- svNummer / Steuernummer falls angegeben
- Jahreseinkommen / Bemessungsgrundlage als nettoverdienst
- steuerdomizil: Land/Ort des Steuerbescheids
- Jahr des Bescheids
Felder → person + haushalt sections`,

  ARBEITSVERTRAG: `Analysiere diesen ARBEITSVERTRAG / DIENSTVERTRAG.
Extrahiere:
- vorname, nachname des Arbeitnehmers
- arbeitgeber: Vollständiger Firmenname
- beruf: Stellenbezeichnung / Position
- anstellungsverhaeltnis: z.B. "Angestellter", "Arbeiter", "freier Dienstnehmer"
- beschaeftigtSeit: Eintrittsdatum (YYYY-MM-DD)
- brutto_gehalt: Monatsbrutto falls angegeben
- Arbeitgeber-Adresse: arbeitgeberStrasse, arbeitgeberHausnummer, arbeitgeberPlz, arbeitgeberOrt
Felder → person section`,

  GRUNDBUCHAUSZUG: `Analysiere diesen GRUNDBUCHAUSZUG.
WICHTIG für österreichische Grundbuchauszüge:
- Das Dokument hat Abschnitte: A1 (Gutsbestand), A2, B (Eigentumsblatt), C (Lastenblatt)
- katastralgemeinde: Steht oben als "KATASTRALGEMEINDE xxxxx Name"
- einlagezahl: Steht oben als "EINLAGEZAHL xxxx"
- grundstuecksnummer: ALLE GST-NR aus A1-Blatt (kommagetrennt)
- grundstuecksflaeche: Gesamtfläche aus A1-Blatt (als Zahl in m²)
- eigentuemer: Aus dem B-Blatt, ALLE Eigentümer mit Anteil und Geburtsdatum
- strasse, hausnummer, plz, ort: Adresse des Grundstücks (aus A1 oder A2)
- belastungen: Pfandrechte/Hypotheken aus C-Blatt, "Keine" wenn leer
ABSOLUT VERBOTEN: Fantasienamen wie "Mustermann" verwenden!
Felder → objekt section`,

  ENERGIEAUSWEIS: `Analysiere diesen ENERGIEAUSWEIS.
Extrahiere:
- energiekennzahl: HWB (Heizwärmebedarf) in kWh/m²a als Zahl
- strasse, hausnummer, plz, ort des Objekts
- baujahr: falls angegeben (als Zahl)
- grundstuecksflaeche / Nutzfläche falls angegeben
- objektTyp: z.B. "Einfamilienhaus", "Wohnung", "Reihenhaus"
Felder → objekt section`,

  KAUFVERTRAG: `Analysiere diesen KAUFVERTRAG / KAUFANBOT.
Extrahiere:
- kaeufer: Name(n) des/der Käufer(s)
- verkaeufer: Name(n) des/der Verkäufer(s)
- kaufpreis: Kaufpreis als Zahl (ohne €-Zeichen)
- strasse, hausnummer, plz, ort des Kaufobjekts
- objektTyp: z.B. "Eigentumswohnung", "Einfamilienhaus", "Grundstück"
- katastralgemeinde, einlagezahl (falls angegeben)
- grundstuecksflaeche (falls angegeben, als Zahl in m²)
- vertragsdatum (YYYY-MM-DD)
Felder → objekt + finanzplan sections`,

  KONTOAUSZUG: `Analysiere diesen KONTOAUSZUG / BANKBELEG.
Extrahiere:
- kontoinhaber: EXAKTER Name
- iban: Beginnt mit "AT" gefolgt von 18 Ziffern
- bank: Vollständiger Bankname
- kontostand: Aktueller/letzter Saldo als Zahl
- auszugsdatum (YYYY-MM-DD)
Felder → person section (kontoverbindung = IBAN)`,

  EXPOSE: `Analysiere dieses EXPOSE / IMMOBILIENANGEBOT.
Extrahiere:
- objektTyp: z.B. "Eigentumswohnung", "Einfamilienhaus", "Reihenhaus"
- strasse, hausnummer, plz, ort
- kaufpreis: Preis als Zahl
- grundstuecksflaeche: Grundstücksfläche in m²
- wohnflaeche: Nutzfläche/Wohnfläche in m²
- baujahr: falls angegeben
- energiekennzahl: HWB falls angegeben
- anzahlZimmer: falls angegeben
- beschreibung: Kurzbeschreibung
Felder → objekt + finanzplan sections`,

  SONSTIGES: `Analysiere dieses Dokument und extrahiere ALLE erkennbaren relevanten Informationen.
Bestimme zuerst den tatsächlichen Dokumenttyp und extrahiere dann die passenden Felder.
Lies EXAKT was im Dokument steht - erfinde KEINE Werte!`,
};

// ============================================================
// Download file from Google Drive as base64 (PDF + Images)
// ============================================================
async function downloadFromGoogleDrive(googleDriveId: string): Promise<{
  base64: string;
  mimeType: string;
  isPdf: boolean;
} | null> {
  try {
    const drive = getGoogleDrive();

    // Get file metadata
    const meta = await drive.files.get({
      fileId: googleDriveId,
      fields: 'id, name, mimeType',
    });

    const fileMimeType = meta.data.mimeType || 'application/octet-stream';
    console.log(`[Jeffrey OCR] Downloading from GDrive: ${meta.data.name} (${fileMimeType})`);

    // Download file content
    const res = await drive.files.get(
      { fileId: googleDriveId, alt: 'media' },
      { responseType: 'arraybuffer' }
    );

    const buffer = Buffer.from(res.data as ArrayBuffer);
    const base64 = buffer.toString('base64');

    // Handle PDFs
    if (fileMimeType === 'application/pdf') {
      console.log(`[Jeffrey OCR] PDF detected (${buffer.length} bytes) — using Claude Document API`);
      return { base64, mimeType: 'application/pdf', isPdf: true };
    }

    // Handle images
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

    console.log(`[Jeffrey OCR] Downloaded: ${buffer.length} bytes, type: ${visionMimeType}`);
    return { base64, mimeType: visionMimeType, isPdf: false };
  } catch (err: any) {
    console.error(`[Jeffrey OCR] GDrive download failed:`, err.message);
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
    let fileData: { base64: string; mimeType: string; isPdf: boolean } | null = null;

    if (doc.googleDriveId) {
      fileData = await downloadFromGoogleDrive(doc.googleDriveId);
    }

    if (!fileData) {
      const reason = doc.googleDriveId ? 'Konnte nicht heruntergeladen werden' : 'Keine Google Drive ID';
      console.log(`[Jeffrey OCR] Skipping ${doc.originalFilename}: ${reason}`);
      await prisma.document.update({
        where: { id: documentId },
        data: { ocrStatus: 'FAILED', ocrError: reason, ocrProcessedAt: new Date() },
      });
      return { documentType: doc.type, extractedFields: {}, sectionsUpdated: [], confidence: 0 };
    }

    // Send to Claude Vision (with PDF or image support)
    const extractionResult = await analyzeWithClaude(
      fileData.base64,
      fileData.mimeType,
      fileData.isPdf,
      doc.originalFilename,
      doc.type
    );

    // Update document type if Claude re-classified it
    const newDocType = mapToDocumentType(extractionResult.documentType);
    if (newDocType && newDocType !== doc.type) {
      console.log(`[Jeffrey OCR] Re-classified: ${doc.type} → ${newDocType}`);
      await prisma.document.update({
        where: { id: documentId },
        data: { type: newDocType as any },
      });
    }

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

    console.log(`[Jeffrey OCR] Done: ${extractionResult.documentType}, ${countFields(extractionResult.fields)} fields, sections: ${sectionsUpdated.join(', ') || 'keine'}`);

    return {
      documentType: extractionResult.documentType,
      extractedFields: extractionResult.fields,
      sectionsUpdated,
      confidence: extractionResult.confidence,
    };

  } catch (err: any) {
    console.error(`[Jeffrey OCR] Error:`, err.message);
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
// Map Claude's document type string to Prisma DocumentType enum
// ============================================================
function mapToDocumentType(claudeType: string): string | null {
  const mapping: Record<string, string> = {
    'REISEPASS': 'REISEPASS',
    'AUSWEIS': 'AUSWEIS',
    'PERSONALAUSWEIS': 'AUSWEIS',
    'AUFENTHALTSTITEL': 'AUSWEIS',
    'MELDEZETTEL': 'MELDEZETTEL',
    'GEHALTSABRECHNUNG': 'GEHALTSABRECHNUNG',
    'LOHNZETTEL': 'GEHALTSABRECHNUNG',
    'L16': 'GEHALTSABRECHNUNG',
    'STEUERBESCHEID': 'STEUERBESCHEID',
    'EINKOMMENSTEUERBESCHEID': 'STEUERBESCHEID',
    'ARBEITSVERTRAG': 'ARBEITSVERTRAG',
    'DIENSTVERTRAG': 'ARBEITSVERTRAG',
    'GRUNDBUCHAUSZUG': 'GRUNDBUCHAUSZUG',
    'ENERGIEAUSWEIS': 'ENERGIEAUSWEIS',
    'KAUFVERTRAG': 'KAUFVERTRAG',
    'KAUFANBOT': 'KAUFVERTRAG',
    'KONTOAUSZUG': 'KONTOAUSZUG',
    'EXPOSE': 'EXPOSE',
    'SONSTIGES': 'SONSTIGES',
  };
  const normalized = claudeType.toUpperCase().replace(/[^A-ZÄÖÜ0-9_]/g, '');
  return mapping[normalized] || null;
}

// ============================================================
// Analyze document with Claude API (Images + PDFs)
// ============================================================
interface ExtractionResult {
  documentType: string;
  confidence: number;
  fields: Record<string, any>;
  targetSections: string[];
}

async function analyzeWithClaude(
  base64Data: string,
  mediaType: string,
  isPdf: boolean,
  filename: string,
  existingType: string
): Promise<ExtractionResult> {

  // Get document-type specific prompt
  const typePrompt = DOCUMENT_TYPE_PROMPTS[existingType] || DOCUMENT_TYPE_PROMPTS['SONSTIGES'];

  const systemPrompt = `Du bist Jeffrey, ein spezialisierter OCR-Agent für die Immobilienfinanzierung in Österreich.
Du analysierst Dokumente und extrahierst strukturierte Daten daraus.

Antworte NUR mit validem JSON. Kein anderer Text, keine Erklärungen, kein Markdown.

DOKUMENTTYP-SPEZIFISCHE ANWEISUNGEN:
${typePrompt}

WENN der tatsächliche Dokumenttyp NICHT mit der Vorklassifizierung übereinstimmt,
korrigiere den documentType im JSON auf den RICHTIGEN Typ. Mögliche Typen:
REISEPASS, AUSWEIS, MELDEZETTEL, GEHALTSABRECHNUNG, STEUERBESCHEID,
ARBEITSVERTRAG, GRUNDBUCHAUSZUG, ENERGIEAUSWEIS, KAUFVERTRAG, KONTOAUSZUG, EXPOSE, SONSTIGES

Extrahiere je nach Dokumenttyp die passenden Felder in die richtigen Sektionen:

PERSON-Felder: anrede, titel, vorname, nachname, strasse, hausnummer, stiege, top, plz, ort, land,
  mobilnummer, telefon, email, geburtsdatum (YYYY-MM-DD), geburtsland, geburtsort,
  staatsbuergerschaft, weitereStaatsbuergerschaft, svNummer, svTraeger,
  wohnart, wohnhaftSeit (YYYY-MM-DD), steuerdomizil, familienstand,
  hoechsteAusbildung, anstellungsverhaeltnis, beruf, arbeitgeber,
  beschaeftigtSeit (YYYY-MM-DD), arbeitgeberStrasse, arbeitgeberHausnummer,
  arbeitgeberPlz, arbeitgeberOrt, kontoverbindung

HAUSHALT-Felder: nettoverdienst (monatlich), bruttoverdienst,
  betriebskostenMiete, energiekosten

FINANZPLAN-Felder: kaufpreis, grundpreis, renovierungskosten,
  finanzierungszweck, objektTyp

OBJEKT-Felder: objektTyp, katastralgemeinde, einlagezahl, grundstuecksnummer,
  grundstuecksflaeche, energiekennzahl, strasse, hausnummer, plz, ort,
  baujahr

JSON Format:
{
  "documentType": "REISEPASS",
  "confidence": 0.95,
  "targetSections": ["person"],
  "fields": {
    "person": { "vorname": "Max", "nachname": "Mustermann" },
    "haushalt": {},
    "finanzplan": {},
    "objekt": {}
  }
}

ABSOLUTE REGELN:
- Lies JEDES Detail aus dem Dokument das du erkennen kannst
- Nur Felder eintragen die du SICHER lesen kannst
- Bei Unsicherheit das Feld WEGLASSEN, nicht raten
- Zahlen als Nummern (nicht als String)
- Datumsfelder als "YYYY-MM-DD"
- confidence zwischen 0.0 und 1.0
- Leere Sektionen als leeres Objekt {} lassen
- NIEMALS Fantasienamen wie "Mustermann", "Max Muster", "Hans Müller" verwenden!
- Achte besonders auf: Namen, Geburtsdaten, Adressen, SV-Nummern, Gehälter, IBANs`;

  // Build content array depending on file type
  const contentParts: any[] = [];

  if (isPdf) {
    // Use Claude's document content type for PDFs
    contentParts.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: base64Data,
      },
    });
  } else {
    // Use image content type for images
    contentParts.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        data: base64Data,
      },
    });
  }

  contentParts.push({
    type: 'text',
    text: `Analysiere dieses Dokument. Dateiname: "${filename}". Vorklassifiziert als: ${existingType}.
Überprüfe ob die Klassifizierung korrekt ist und korrigiere sie falls nötig.
Extrahiere ALLE erkennbaren Felder. Antworte NUR mit JSON.`,
  });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: contentParts,
      },
    ],
  });

  const textContent = response.content.find((c: any) => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('Keine Text-Antwort von Claude');
  }

  let jsonStr = textContent.text.trim();
  // Remove markdown code fences if present
  jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  console.log(`[Jeffrey OCR] Claude response: ${jsonStr.substring(0, 300)}...`);

  // Filter out fake/placeholder names before parsing
  const FAKE_PATTERNS = [
    /mustermann/i, /musterfrau/i, /max\s+muster/i, /peter\s+muster/i,
    /hans\s+m[uü]ller/i, /erika\s+muster/i, /john\s+doe/i, /jane\s+doe/i,
    /test\s*(person|name|firma)/i, /beispiel/i, /platzhalter/i,
  ];

  try {
    const parsed = JSON.parse(jsonStr) as ExtractionResult;

    // Sanitize: remove any fake/placeholder values
    if (parsed.fields) {
      for (const section of Object.values(parsed.fields)) {
        if (section && typeof section === 'object') {
          for (const [key, value] of Object.entries(section as Record<string, any>)) {
            if (value && typeof value === 'string' && FAKE_PATTERNS.some(p => p.test(value))) {
              console.log(`[Jeffrey OCR] Fake value removed: ${key} = "${value}"`);
              delete (section as Record<string, any>)[key];
            }
          }
        }
      }
    }

    return parsed;
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
      const existing = await prisma.customerPerson.findFirst({ where: { leadId }, orderBy: { personNumber: 'asc' } });
      if (existing) {
        const updates = getEmptyFieldUpdates(existing, data);
        if (Object.keys(updates).length > 0) {
          await prisma.customerPerson.update({ where: { id: existing.id }, data: updates });
          sectionsUpdated.push(`Person (${Object.keys(updates).length} Felder)`);
        }
      } else {
        await prisma.customerPerson.create({ data: { leadId, personNumber: 1, ...data } });
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
// Field sanitizers — expanded to cover all Prisma schema fields
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
    'kontoverbindung', 'neuesKonto', 'neuesKontoBeiBank',
    'anmerkungen', 'berater', 'finanzierungsstandort',
    'anmerkungPensionsantritt',
  ];
  const dateFields = ['geburtsdatum', 'wohnhaftSeit', 'beschaeftigtSeit'];
  const intFields = ['anzahlKinder', 'unterhaltsberechtigtePersonen', 'alterBeiLaufzeitende', 'vorbeschaeftigungsdauerMonate'];
  const boolFields = ['eigenesKfz'];

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined || value === '') continue;

    if (stringFields.includes(key)) {
      result[key] = String(value);
    } else if (dateFields.includes(key)) {
      try {
        const d = new Date(String(value));
        if (!isNaN(d.getTime())) result[key] = d;
      } catch { /* skip invalid dates */ }
    } else if (intFields.includes(key)) {
      const num = parseInt(String(value));
      if (!isNaN(num)) result[key] = num;
    } else if (boolFields.includes(key)) {
      if (typeof value === 'boolean') result[key] = value;
      else if (String(value).toLowerCase() === 'ja' || String(value).toLowerCase() === 'true') result[key] = true;
      else if (String(value).toLowerCase() === 'nein' || String(value).toLowerCase() === 'false') result[key] = false;
    }
  }

  // Map geschlecht → anrede
  if (raw.geschlecht && !result.anrede) {
    const g = String(raw.geschlecht).toLowerCase();
    if (g.includes('m') || g.includes('männ')) result.anrede = 'Herr';
    if (g.includes('w') || g.includes('weib') || g.includes('f')) result.anrede = 'Frau';
  }

  // Map IBAN → kontoverbindung
  if (raw.iban && !result.kontoverbindung) {
    result.kontoverbindung = String(raw.iban);
  }

  // Map arbeitnehmer_name → vorname + nachname (from Gehaltsabrechnung)
  if (raw.arbeitnehmer_name && !result.vorname && !result.nachname) {
    const parts = String(raw.arbeitnehmer_name).trim().split(/\s+/);
    if (parts.length >= 2) {
      result.nachname = parts[0]; // Austrian Lohnzettel: Nachname first
      result.vorname = parts.slice(1).join(' ');
    }
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
  const stringFields = ['argumentationEinkuenfte', 'anmerkungen', 'anmerkungWohnkosten'];

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined || value === '') continue;
    if (floatFields.includes(key)) {
      const n = parseFloat(String(value).replace(/[^\d.,-]/g, '').replace(',', '.'));
      if (!isNaN(n)) result[key] = n;
    } else if (stringFields.includes(key)) {
      result[key] = String(value);
    }
  }

  // Handle nettoverdienst → einkommen JSON array
  if (raw.nettoverdienst) {
    const n = parseFloat(String(raw.nettoverdienst).replace(/[^\d.,-]/g, '').replace(',', '.'));
    if (!isNaN(n)) {
      const einkommen: any[] = [{ name: 'Kreditnehmer', nettoverdienst: n }];
      // Also add bruttoverdienst if available
      if (raw.bruttoverdienst || raw.brutto_gehalt) {
        const brutto = parseFloat(String(raw.bruttoverdienst || raw.brutto_gehalt).replace(/[^\d.,-]/g, '').replace(',', '.'));
        if (!isNaN(brutto)) {
          einkommen[0].bruttoverdienst = brutto;
        }
      }
      result.einkommen = einkommen;
    }
  }

  // Handle brutto_gehalt / netto_gehalt from Gehaltsabrechnung OCR
  if (!result.einkommen && (raw.brutto_gehalt || raw.netto_gehalt)) {
    const einkommen: any = { name: 'Kreditnehmer' };
    if (raw.netto_gehalt) {
      const n = parseFloat(String(raw.netto_gehalt).replace(/[^\d.,-]/g, '').replace(',', '.'));
      if (!isNaN(n)) einkommen.nettoverdienst = n;
    }
    if (raw.brutto_gehalt) {
      const b = parseFloat(String(raw.brutto_gehalt).replace(/[^\d.,-]/g, '').replace(',', '.'));
      if (!isNaN(b)) einkommen.bruttoverdienst = b;
    }
    if (einkommen.nettoverdienst || einkommen.bruttoverdienst) {
      result.einkommen = [einkommen];
    }
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
    'eigenmittelBar', 'verkaufserloese', 'abloesekapitalVersicherung',
    'bausparguthaben', 'summeEigenmittel', 'foerderung', 'sonstigeMittel',
    'zwischenfinanzierungNetto', 'finanzierungsnebenkostenZwischen',
    'zwischenfinanzierungBrutto', 'langfrFinanzierungsbedarfNetto',
    'finanzierungsnebenkosten', 'langfrFinanzierungsbedarfBrutto',
    'bearbeitungsspesen', 'kreditvermittlerprovision', 'schaetzgebuehr',
    'eintragungsgebuehrPfandrecht', 'legalisierungsgebuehren',
    'grundbucheintragung', 'grundbuchauszug', 'finanzierungsberatungshonorar',
    'zwischenKreditbetrag', 'zwischenZinssatz', 'zwischenBearbeitungsspesen',
    'garantieBetrag',
  ];
  const intFields = ['zwischenLaufzeitMonate', 'garantieLaufzeitMonate'];
  const stringFields = [
    'finanzierungszweck', 'objektTyp', 'anmerkungen',
    'zwischenAbdeckungDurch', 'zwischenSicherheiten', 'garantieOriginalAn',
  ];
  const boolFields = ['vorfinanzierung'];
  const dateFields = ['garantieTermin'];

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined || value === '') continue;

    if (floatFields.includes(key)) {
      const n = parseFloat(String(value).replace(/[^\d.,-]/g, '').replace(',', '.'));
      if (!isNaN(n)) result[key] = n;
    } else if (intFields.includes(key)) {
      const n = parseInt(String(value));
      if (!isNaN(n)) result[key] = n;
    } else if (stringFields.includes(key)) {
      result[key] = String(value);
    } else if (boolFields.includes(key)) {
      if (typeof value === 'boolean') result[key] = value;
    } else if (dateFields.includes(key)) {
      try {
        const d = new Date(String(value));
        if (!isNaN(d.getTime())) result[key] = d;
      } catch { /* skip */ }
    }
  }

  return result;
}

function sanitizeObjektFields(raw: any): Record<string, any> {
  const stringFields = [
    'objektTyp', 'katastralgemeinde', 'einlagezahl', 'grundstuecksnummer',
    'strasse', 'hausnummer', 'plz', 'ort',
    'zugehoerigkeitKreditnehmer', 'materialanteil', 'orientierung',
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
  const dateFields = ['baubeginn', 'bauende'];

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined || value === '') continue;

    if (stringFields.includes(key)) {
      result[key] = String(value);
    } else if (floatFields.includes(key)) {
      const n = parseFloat(String(value).replace(/[^\d.,-]/g, '').replace(',', '.'));
      if (!isNaN(n)) result[key] = n;
    } else if (intFields.includes(key)) {
      const n = parseInt(String(value));
      if (!isNaN(n)) result[key] = n;
    } else if (boolFields.includes(key)) {
      if (typeof value === 'boolean') result[key] = value;
      else if (String(value).toLowerCase() === 'ja' || String(value).toLowerCase() === 'true') result[key] = true;
      else if (String(value).toLowerCase() === 'nein' || String(value).toLowerCase() === 'false') result[key] = false;
    } else if (dateFields.includes(key)) {
      try {
        const d = new Date(String(value));
        if (!isNaN(d.getTime())) result[key] = d;
      } catch { /* skip */ }
    }
  }

  // Map wohnflaeche to appropriate area field
  if (raw.wohnflaeche && !result.flaecheErdgeschoss) {
    const n = parseFloat(String(raw.wohnflaeche).replace(/[^\d.,-]/g, '').replace(',', '.'));
    if (!isNaN(n)) result.flaecheErdgeschoss = n;
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

  const results: any[] = [];
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
