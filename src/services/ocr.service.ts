// src/services/ocr.service.ts
import OpenAI from 'openai';

// Lazy initialization
let openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

// ============================================================
// Document Type Schemas
// ============================================================

export const DOCUMENT_SCHEMAS: Record<string, {
  label: string;
  prismaType: string;
  fields: { name: string; type: string; label: string }[];
  extractionPrompt: string;
}> = {
  gehaltsabrechnung: {
    label: 'Gehaltszettel / Lohnzettel',
    prismaType: 'GEHALTSABRECHNUNG',
    fields: [
      { name: 'arbeitgeber', type: 'text', label: 'Arbeitgeber' },
      { name: 'arbeitnehmer_name', type: 'text', label: 'Name Arbeitnehmer' },
      { name: 'brutto_gehalt', type: 'currency', label: 'Brutto-Gehalt' },
      { name: 'netto_gehalt', type: 'currency', label: 'Netto-Gehalt' },
      { name: 'abrechnungsmonat', type: 'text', label: 'Abrechnungsmonat' },
      { name: 'sozialversicherungsnummer', type: 'text', label: 'SV-Nummer' },
      { name: 'steuerklasse', type: 'text', label: 'Steuerklasse' },
      { name: 'sonderzahlungen', type: 'currency', label: 'Sonderzahlungen' },
    ],
    extractionPrompt: `Du extrahierst Daten aus einem österreichischen Lohnzettel (L16) oder einer Gehaltsabrechnung.

WICHTIGE REGELN für österreichische Lohnzettel:
- "arbeitgeber": Steht meist unten als Firmenname mit Adresse und Telefonnummer. NICHT "MBA" oder Kürzel - suche den vollständigen Firmennamen.
- "arbeitnehmer_name": Der Name steht oben links unter "Arbeitnehmer*in" - lies den EXAKTEN Namen (Nachname + Vorname), erfinde keinen!
- "brutto_gehalt": Lies Zeile (210) "Bruttobezüge gemäß §25" - das ist der Jahresbrutto. Bei monatlichen Abrechnungen das Monatsbrutto.
- "netto_gehalt": Oft nicht direkt angegeben bei L16-Lohnzetteln. Wenn nicht vorhanden, null.
- "sozialversicherungsnummer" / "Vers.-Nr.": Die 10-stellige Nummer, oft oben rechts. Lies sie EXAKT ab, Ziffer für Ziffer.
- "abrechnungsmonat": Der Zeitraum "vom ... bis ..." oben im Dokument.

NIEMALS Werte erfinden! Wenn ein Feld nicht lesbar ist, setze null.`,
  },
  kontoauszug: {
    label: 'Kontoauszug',
    prismaType: 'KONTOAUSZUG',
    fields: [
      { name: 'bank_name', type: 'text', label: 'Bank' },
      { name: 'kontoinhaber', type: 'text', label: 'Kontoinhaber' },
      { name: 'iban', type: 'text', label: 'IBAN' },
      { name: 'kontostand', type: 'currency', label: 'Kontostand' },
      { name: 'auszugsdatum', type: 'date', label: 'Auszugsdatum' },
      { name: 'auszugsnummer', type: 'text', label: 'Auszugsnummer' },
    ],
    extractionPrompt: `Du extrahierst Daten aus einem österreichischen Kontoauszug.

WICHTIGE REGELN:
- Lies den EXAKTEN Namen des Kontoinhabers - erfinde keinen!
- IBAN: Beginnt mit "AT" gefolgt von 18 Ziffern
- Kontostand: Der letzte/aktuelle Saldo
- Bank: Der vollständige Bankname

NIEMALS Werte erfinden! Wenn ein Feld nicht lesbar ist, setze null.`,
  },
  kaufvertrag: {
    label: 'Kaufvertrag',
    prismaType: 'KAUFVERTRAG',
    fields: [
      { name: 'kaeufer_name', type: 'text', label: 'Käufer' },
      { name: 'verkaeufer_name', type: 'text', label: 'Verkäufer' },
      { name: 'kaufpreis', type: 'currency', label: 'Kaufpreis' },
      { name: 'objekt_adresse', type: 'text', label: 'Objektadresse' },
      { name: 'grundstuecksgroesse', type: 'text', label: 'Grundstücksgröße' },
      { name: 'vertragsdatum', type: 'date', label: 'Vertragsdatum' },
      { name: 'notar', type: 'text', label: 'Notar' },
    ],
    extractionPrompt: `Du extrahierst Daten aus einem österreichischen Immobilien-Kaufvertrag.

WICHTIGE REGELN:
- Lies alle Namen EXAKT aus dem Dokument - erfinde keine!
- Kaufpreis: Der vereinbarte Gesamtkaufpreis
- Adresse: Die vollständige Objektadresse

NIEMALS Werte erfinden! Wenn ein Feld nicht lesbar ist, setze null.`,
  },
  grundbuchauszug: {
    label: 'Grundbuchauszug',
    prismaType: 'GRUNDBUCHAUSZUG',
    fields: [
      { name: 'eigentuemer', type: 'text', label: 'Eigentümer' },
      { name: 'grundstuecksnummer', type: 'text', label: 'Grundstücksnummer' },
      { name: 'katastralgemeinde', type: 'text', label: 'Katastralgemeinde' },
      { name: 'einlagezahl', type: 'text', label: 'Einlagezahl' },
      { name: 'flaeche', type: 'text', label: 'Fläche' },
      { name: 'belastungen', type: 'text', label: 'Belastungen/Hypotheken' },
      { name: 'eigentumsanteil', type: 'text', label: 'Eigentumsanteil' },
    ],
    extractionPrompt: `Du extrahierst Daten aus einem österreichischen Grundbuchauszug.

WICHTIGE REGELN für österreichische Grundbuchauszüge:
- Das Dokument hat Abschnitte A1 (Gutsbestand), A2, B (Eigentumsblatt) und C (Lastenblatt).
- "eigentuemer": Stehen im B-Blatt. Es können MEHRERE Eigentümer sein! Liste ALLE mit Name und Anteil auf, getrennt durch Semikolon. Format: "Name (Anteil: X/Y, GEB: TT.MM.JJJJ)". Lies die EXAKTEN Namen - sie stehen nach "ANTEIL:" im B-Blatt.
- "grundstuecksnummer": ALLE GST-NR aus dem A1-Blatt, getrennt durch Komma (z.B. "238, 1444/2")
- "katastralgemeinde": Steht oben als "KATASTRALGEMEINDE xxxxx Name"
- "einlagezahl": Steht oben als "EINLAGEZAHL xxxx"
- "flaeche": Die GESAMTFLÄCHE aus dem A1-Blatt
- "belastungen": Aus dem C-Blatt (Pfandrechte, Hypotheken). "Keine" wenn C-Blatt leer oder nicht vorhanden.
- "eigentumsanteil": Die Anteile der Eigentümer

ABSOLUT VERBOTEN: Standardnamen wie "Peter Muster", "Max Mustermann", "Hans Müller" verwenden!
Lies die echten Namen aus dem B-Blatt. Wenn nicht lesbar: "nicht lesbar".`,
  },
  reisepass: {
    label: 'Reisepass',
    prismaType: 'REISEPASS',
    fields: [
      { name: 'nachname', type: 'text', label: 'Nachname' },
      { name: 'vorname', type: 'text', label: 'Vorname' },
      { name: 'geburtsdatum', type: 'date', label: 'Geburtsdatum' },
      { name: 'geburtsort', type: 'text', label: 'Geburtsort' },
      { name: 'staatsangehoerigkeit', type: 'text', label: 'Staatsangehörigkeit' },
      { name: 'passnummer', type: 'text', label: 'Passnummer' },
      { name: 'ausstellungsdatum', type: 'date', label: 'Ausstellungsdatum' },
      { name: 'ablaufdatum', type: 'date', label: 'Ablaufdatum' },
      { name: 'geschlecht', type: 'text', label: 'Geschlecht' },
    ],
    extractionPrompt: `Du extrahierst Daten aus einem Reisepass.

WICHTIGE REGELN:
- Lies die MRZ (Machine Readable Zone) unten am Pass wenn vorhanden
- Alle Namen und Daten EXAKT ablesen
- Geburtsdatum im Format YYYY-MM-DD

NIEMALS Werte erfinden!`,
  },
  ausweis: {
    label: 'Personalausweis',
    prismaType: 'AUSWEIS',
    fields: [
      { name: 'nachname', type: 'text', label: 'Nachname' },
      { name: 'vorname', type: 'text', label: 'Vorname' },
      { name: 'geburtsdatum', type: 'date', label: 'Geburtsdatum' },
      { name: 'geburtsort', type: 'text', label: 'Geburtsort' },
      { name: 'staatsangehoerigkeit', type: 'text', label: 'Staatsangehörigkeit' },
      { name: 'ausweisnummer', type: 'text', label: 'Ausweisnummer' },
      { name: 'ausstellungsdatum', type: 'date', label: 'Ausstellungsdatum' },
      { name: 'ablaufdatum', type: 'date', label: 'Ablaufdatum' },
      { name: 'adresse', type: 'text', label: 'Adresse' },
    ],
    extractionPrompt: `Du extrahierst Daten aus einem Personalausweis oder Aufenthaltstitel.

WICHTIGE REGELN:
- Alle Namen und Daten EXAKT ablesen
- Geburtsdatum im Format YYYY-MM-DD

NIEMALS Werte erfinden!`,
  },
  sonstiges: {
    label: 'Sonstiges Dokument',
    prismaType: 'SONSTIGES',
    fields: [
      { name: 'dokumenttyp_erkannt', type: 'text', label: 'Erkannter Dokumenttyp' },
      { name: 'personen_namen', type: 'text', label: 'Genannte Personen' },
      { name: 'betraege', type: 'text', label: 'Genannte Beträge' },
      { name: 'datum', type: 'date', label: 'Datum' },
      { name: 'zusammenfassung', type: 'text', label: 'Zusammenfassung' },
    ],
    extractionPrompt: `Extrahiere alle erkennbaren Informationen aus diesem Dokument.
Lies EXAKT was im Dokument steht - erfinde keine Werte!`,
  },
};

// ============================================================
// Image Processing
// ============================================================

async function imageToBase64(imageBuffer: Buffer, mimeType: string) {
  let optimized: Buffer;
  try {
    const sharp = require('sharp');
    optimized = await sharp(imageBuffer)
      .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
      .sharpen()
      .toBuffer();
  } catch {
    optimized = imageBuffer;
  }

  const base64 = optimized.toString('base64');
  return {
    type: 'image_url' as const,
    image_url: {
      url: `data:${mimeType};base64,${base64}`,
      detail: 'high' as const,
    },
  };
}

function pdfToVisionContent(pdfBuffer: Buffer) {
  const base64 = pdfBuffer.toString('base64');
  return [{
    type: 'file' as const,
    file: {
      filename: 'document.pdf',
      file_data: `data:application/pdf;base64,${base64}`,
    },
  }];
}

// ============================================================
// Main OCR Analysis
// ============================================================

export interface OcrResult {
  documentType: string;
  documentTypeLabel: string;
  prismaType: string;
  fields: Record<string, { value: string | number | null; confidence: number }>;
  personenNamen: string[];
  overallConfidence: number;
}

export async function analyzeDocument(
  fileBuffer: Buffer,
  mimeType: string,
  filename: string
): Promise<OcrResult> {
  console.log(`[OCR] Analyzing: ${filename} (${mimeType})`);

  let imageContent: any[];
  if (mimeType === 'application/pdf') {
    imageContent = pdfToVisionContent(fileBuffer);
  } else if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)) {
    const img = await imageToBase64(fileBuffer, mimeType);
    imageContent = [img];
  } else {
    throw new Error(`Unsupported file type: ${mimeType}`);
  }

  // Step 1: Classify document type
  const classificationResponse = await getOpenAI().chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `Du bist ein Experte für österreichische Finanzdokumente im Immobilienkredit-Bereich.
Klassifiziere das Dokument in GENAU eine dieser Kategorien:

- gehaltsabrechnung → Lohnzettel, Gehaltsabrechnung, Bezugszettel, Jahreslohnzettel, L16, Lohnkonto
- kontoauszug → Bankkontoauszug, Sparbuch-Auszug, Kontoinformation
- kaufvertrag → Immobilien-Kaufvertrag, Kaufanbot, Kaufvereinbarung
- grundbuchauszug → Grundbuchauszug, Auszug aus dem Hauptbuch, GB-Auszug, Liegenschaftsauszug
- reisepass → Reisepass, Passport, Putovnica
- ausweis → Personalausweis, Führerschein, Aufenthaltstitel, Meldezettel
- sonstiges → alles andere

HINWEISE:
- Ein Dokument mit "Lohnzettel" im Titel ist IMMER "gehaltsabrechnung"
- Ein Dokument mit "Auszug aus dem Hauptbuch" ist IMMER "grundbuchauszug"
- Ein Dokument mit "JUSTIZ" und "GRUNDBUCH" Logo ist "grundbuchauszug"
- Auch Jahreslohnzettel (L16) sind "gehaltsabrechnung"
- Steuerliche Formulare mit Bruttobezügen sind "gehaltsabrechnung"

Antworte NUR mit dem Kategorienamen, sonst nichts.`,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Klassifiziere dieses Dokument (Dateiname: ${filename}):` },
          ...imageContent,
        ],
      },
    ],
    max_tokens: 50,
    temperature: 0,
  });

  const rawType = classificationResponse.choices[0].message.content?.trim().toLowerCase().replace(/[^a-z_]/g, '') || 'sonstiges';
  const documentType = DOCUMENT_SCHEMAS[rawType] ? rawType : 'sonstiges';
  const schema = DOCUMENT_SCHEMAS[documentType];

  console.log(`[OCR] Classified as: ${schema.label}`);

  // Step 2: Extract data
  const fieldsDescription = schema.fields
    .map((f) => `- "${f.name}" (${f.type}): ${f.label}`)
    .join('\n');

  const extractionResponse = await getOpenAI().chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `Du bist ein präziser OCR-Datenextrahierer für österreichische Finanzdokumente.

${schema.extractionPrompt}

Erwartete Felder:
${fieldsDescription}

ABSOLUTE REGELN - VERSTÖSSE SIND VERBOTEN:
1. Lies EXAKT was im Dokument steht - NIEMALS Werte erfinden oder schätzen!
2. Wenn du einen Wert nicht klar lesen kannst, setze null - NICHT raten!
3. Verwende NIEMALS Platzhalter wie "Mustermann", "Hans Müller", "Peter Muster", "Max Muster" etc.
4. Währungsbeträge als Zahl ohne Währungszeichen (z.B. 95525.92)
5. Datumsformat: YYYY-MM-DD
6. Confidence: 0.0-1.0 pro Feld (0.0 = geraten, 1.0 = klar lesbar)
7. "personen_namen": Array mit ALLEN im Dokument genannten echten Personennamen

Antwort-Format (nur JSON):
{
  "fields": { "feldname": { "value": "...", "confidence": 0.95 } },
  "personen_namen": ["Echter Name 1", "Echter Name 2"],
  "overall_confidence": 0.9
}`,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Extrahiere die Daten aus diesem ${schema.label}. Lies EXAKT was im Dokument steht - erfinde KEINE Werte:` },
          ...imageContent,
        ],
      },
    ],
    max_tokens: 2000,
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  const extracted = JSON.parse(extractionResponse.choices[0].message.content || '{}');

  // Post-processing: Detect and remove placeholder/fake values
  const FAKE_PATTERNS = [
    /mustermann/i, /musterfrau/i, /musterfirma/i, /musterstra[sß]e/i, /musterstadt/i,
    /max\s+muster/i, /peter\s+muster/i, /hans\s+m[uü]ller/i, /erika\s+muster/i,
    /john\s+doe/i, /jane\s+doe/i, /max\s+m[uü]ller/i, /test\s*(firma|person|name)/i,
    /^muster$/i, /^test$/i, /beispiel/i, /platzhalter/i,
    /1234\s*(musterstadt|stadt)/i, /muster\s*gmbh/i,
  ];

  function isFakeValue(value: any): boolean {
    if (value === null || value === undefined) return false;
    const str = String(value);
    return FAKE_PATTERNS.some((p) => p.test(str));
  }

  const fields = extracted.fields || {};
  for (const [key, field] of Object.entries(fields)) {
    const f = field as any;
    if (isFakeValue(f?.value)) {
      console.log(`[OCR] ⚠️ Fake value detected in "${key}": "${f.value}" → set to null`);
      f.value = null;
      f.confidence = 0;
    }
  }

  // Also filter fake person names
  const personenNamen = (extracted.personen_namen || []).filter((n: string) => !isFakeValue(n));

  console.log(`[OCR] Extracted ${Object.keys(fields).length} fields, confidence: ${extracted.overall_confidence}`);

  return {
    documentType,
    documentTypeLabel: schema.label,
    prismaType: schema.prismaType,
    fields,
    personenNamen,
    overallConfidence: extracted.overall_confidence || 0,
  };
}