// src/services/stellungnahme.service.ts
//
// Stellungnahme-Generator: Erstellt automatisch eine professionelle
// Stellungnahme zur geplanten Finanzierung basierend auf Kundendaten.
//
// Workflow:
//   1. Kundendaten sammeln (Person, Haushalt, Finanzplan, Objekt)
//   2. Claude API generiert den Text
//   3. User reviewed/editiert in der App
//   4. PDF wird erstellt und in Google Drive hochgeladen
//

import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient } from '@prisma/client';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { Readable } from 'stream';

const prisma = new PrismaClient() as any;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ============================================================
// 1. Kundendaten sammeln
// ============================================================

async function gatherCustomerData(leadId: string) {
  const [lead, personen, haushalt, finanzplan, objekte] = await Promise.all([
    prisma.lead.findUnique({
      where: { id: leadId },
      include: { assignedTo: { select: { name: true } }, deal: true },
    }),
    prisma.customerPerson.findMany({
      where: { leadId },
      orderBy: { personNumber: 'asc' },
    }),
    prisma.customerHaushalt.findUnique({ where: { leadId } }),
    prisma.customerFinanzplan.findUnique({ where: { leadId } }),
    prisma.customerObjekt.findMany({
      where: { leadId },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  if (!lead) throw new Error('Lead nicht gefunden');
  if (personen.length === 0) throw new Error('Keine Personendaten vorhanden');

  return { lead, personen, haushalt, finanzplan, objekte };
}

function formatCustomerDataForPrompt(data: any): string {
  const { lead, personen, haushalt, finanzplan, objekte } = data;
  const lines: string[] = [];

  // ── Personen ──
  for (const p of personen) {
    lines.push(`--- Kreditnehmer ${p.personNumber} ---`);
    if (p.anrede) lines.push(`Anrede: ${p.anrede}`);
    if (p.titel) lines.push(`Titel: ${p.titel}`);
    if (p.vorname || p.nachname) lines.push(`Name: ${p.vorname || ''} ${p.nachname || ''}`);
    if (p.geburtsdatum) lines.push(`Geburtsdatum: ${new Date(p.geburtsdatum).toLocaleDateString('de-AT')}`);
    if (p.geburtsland) lines.push(`Geburtsland: ${p.geburtsland}`);
    if (p.geburtsort) lines.push(`Geburtsort: ${p.geburtsort}`);
    if (p.staatsbuergerschaft) lines.push(`Staatsbürgerschaft: ${p.staatsbuergerschaft}`);
    if (p.weitereStaatsbuergerschaft) lines.push(`Weitere Staatsbürgerschaft: ${p.weitereStaatsbuergerschaft}`);
    if (p.familienstand) lines.push(`Familienstand: ${p.familienstand}`);
    if (p.anzahlKinder !== null && p.anzahlKinder !== undefined) lines.push(`Anzahl Kinder: ${p.anzahlKinder}`);
    if (p.unterhaltsberechtigtePersonen !== null && p.unterhaltsberechtigtePersonen !== undefined) lines.push(`Unterhaltsberechtigte Personen: ${p.unterhaltsberechtigtePersonen}`);
    if (p.hoechsteAusbildung) lines.push(`Höchste Ausbildung: ${p.hoechsteAusbildung}`);
    if (p.anstellungsverhaeltnis) lines.push(`Anstellungsverhältnis: ${p.anstellungsverhaeltnis}`);
    if (p.beruf) lines.push(`Beruf: ${p.beruf}`);
    if (p.arbeitgeber) lines.push(`Arbeitgeber: ${p.arbeitgeber}`);
    if (p.beschaeftigtSeit) lines.push(`Beschäftigt seit: ${new Date(p.beschaeftigtSeit).toLocaleDateString('de-AT')}`);
    if (p.wohnart) lines.push(`Wohnart: ${p.wohnart}`);
    if (p.wohnhaftSeit) lines.push(`Wohnhaft seit: ${new Date(p.wohnhaftSeit).toLocaleDateString('de-AT')}`);
    if (p.eigenesKfz !== null && p.eigenesKfz !== undefined) lines.push(`Eigenes KFZ: ${p.eigenesKfz ? 'Ja' : 'Nein'}`);
    if (p.kontoverbindung) lines.push(`Kontoverbindung: ${p.kontoverbindung}`);
    if (p.strasse || p.plz || p.ort) {
      lines.push(`Adresse: ${p.strasse || ''} ${p.hausnummer || ''}, ${p.plz || ''} ${p.ort || ''}`);
    }
    if (p.anmerkungen) lines.push(`Anmerkungen: ${p.anmerkungen}`);
    lines.push('');
  }

  // ── Haushalt ──
  if (haushalt) {
    lines.push('--- Haushalt ---');
    const einkommen = Array.isArray(haushalt.einkommen) ? haushalt.einkommen : [];
    for (const e of einkommen) {
      lines.push(`Einkommen ${e.name || 'Kreditnehmer'}: Nettoverdienst ${e.nettoverdienst || 'k.A.'} €/Monat, Gehälter 14x: ${e.gehaelter14 || 'k.A.'}, Sonstige Einkünfte: ${e.sonstigeEinkuenfte || '0'} €`);
    }
    if (haushalt.argumentationEinkuenfte) lines.push(`Argumentation Einkünfte: ${haushalt.argumentationEinkuenfte}`);
    if (haushalt.betriebskostenMiete) lines.push(`Betriebskosten/Miete: ${haushalt.betriebskostenMiete} €`);
    if (haushalt.energiekosten) lines.push(`Energiekosten: ${haushalt.energiekosten} €`);
    if (haushalt.telefonInternet) lines.push(`Telefon/Internet: ${haushalt.telefonInternet} €`);
    if (haushalt.tvGebuehren) lines.push(`TV-Gebühren: ${haushalt.tvGebuehren} €`);
    if (haushalt.transportkosten) lines.push(`Transportkosten: ${haushalt.transportkosten} €`);
    if (haushalt.versicherungen) lines.push(`Versicherungen: ${haushalt.versicherungen} €`);
    if (haushalt.lebenshaltungskostenKreditbeteiligte) lines.push(`Lebenshaltungskosten Kreditbeteiligte: ${haushalt.lebenshaltungskostenKreditbeteiligte} €`);
    if (haushalt.lebenshaltungskostenKinder) lines.push(`Lebenshaltungskosten Kinder: ${haushalt.lebenshaltungskostenKinder} €`);
    if (haushalt.gesonderteAusgabenKinder) lines.push(`Gesonderte Ausgaben Kinder: ${haushalt.gesonderteAusgabenKinder} €`);
    if (haushalt.alimente) lines.push(`Alimente: ${haushalt.alimente} €`);

    // Bestandskredite
    const bestandskredite = Array.isArray(haushalt.bestandskredite) ? haushalt.bestandskredite : [];
    for (const k of bestandskredite) {
      lines.push(`Bestandskredit: Institut ${k.institut || 'k.A.'}, Ursprünglich ${k.urspruenglicherBetrag || 'k.A.'} €, Aushaftung ${k.aushaftung || 'k.A.'} €, Rate ${k.monatlicheRate || 'k.A.'} €/Monat, wird abgedeckt: ${k.wirdAbgedeckt ? 'Ja' : 'Nein'}`);
    }

    if (haushalt.summeEinnahmen) lines.push(`Summe Einnahmen: ${haushalt.summeEinnahmen} €`);
    if (haushalt.summeAusgaben) lines.push(`Summe Ausgaben: ${haushalt.summeAusgaben} €`);
    if (haushalt.freiVerfuegbaresEinkommen) lines.push(`Frei verfügbares Einkommen: ${haushalt.freiVerfuegbaresEinkommen} €`);
    if (haushalt.zumutbareKreditrate) lines.push(`Zumutbare Kreditrate: ${haushalt.zumutbareKreditrate} €`);
    if (haushalt.anmerkungen) lines.push(`Anmerkungen Haushalt: ${haushalt.anmerkungen}`);
    lines.push('');
  }

  // ── Finanzplan ──
  if (finanzplan) {
    lines.push('--- Finanzplan ---');
    if (finanzplan.finanzierungszweck) lines.push(`Finanzierungszweck: ${finanzplan.finanzierungszweck}`);
    if (finanzplan.objektTyp) lines.push(`Objekttyp: ${finanzplan.objektTyp}`);
    if (finanzplan.kaufpreis) lines.push(`Kaufpreis: ${finanzplan.kaufpreis} €`);
    if (finanzplan.grundpreis) lines.push(`Grundpreis: ${finanzplan.grundpreis} €`);
    if (finanzplan.aufschliessungskosten) lines.push(`Aufschließungskosten: ${finanzplan.aufschliessungskosten} €`);
    if (finanzplan.baukostenKueche) lines.push(`Baukosten/Küche: ${finanzplan.baukostenKueche} €`);
    if (finanzplan.renovierungskosten) lines.push(`Renovierungskosten: ${finanzplan.renovierungskosten} €`);
    if (finanzplan.summeProjektkosten) lines.push(`Summe Projektkosten: ${finanzplan.summeProjektkosten} €`);
    if (finanzplan.summeKaufnebenkosten) lines.push(`Summe Kaufnebenkosten: ${finanzplan.summeKaufnebenkosten} €`);
    if (finanzplan.eigenmittelBar) lines.push(`Eigenmittel bar: ${finanzplan.eigenmittelBar} €`);
    if (finanzplan.verkaufserloese) lines.push(`Verkaufserlöse: ${finanzplan.verkaufserloese} €`);
    if (finanzplan.abloesekapitalVersicherung) lines.push(`Ablösekapital Versicherung: ${finanzplan.abloesekapitalVersicherung} €`);
    if (finanzplan.bausparguthaben) lines.push(`Bausparguthaben: ${finanzplan.bausparguthaben} €`);
    if (finanzplan.summeEigenmittel) lines.push(`Summe Eigenmittel: ${finanzplan.summeEigenmittel} €`);
    if (finanzplan.foerderung) lines.push(`Förderung: ${finanzplan.foerderung} €`);
    if (finanzplan.sonstigeMittel) lines.push(`Sonstige Mittel: ${finanzplan.sonstigeMittel} €`);
    if (finanzplan.langfrFinanzierungsbedarfBrutto) lines.push(`Langfr. Finanzierungsbedarf brutto: ${finanzplan.langfrFinanzierungsbedarfBrutto} €`);
    if (finanzplan.kreditvermittlerprovision) lines.push(`Kreditvermittlerprovision: ${finanzplan.kreditvermittlerprovision} €`);
    if (finanzplan.schaetzgebuehr) lines.push(`Schätzgebühr: ${finanzplan.schaetzgebuehr} €`);
    if (finanzplan.anmerkungen) lines.push(`Anmerkungen Finanzplan: ${finanzplan.anmerkungen}`);
    lines.push('');
  }

  // ── Objekte ──
  for (const o of objekte) {
    lines.push(`--- Objekt ---`);
    if (o.objektTyp) lines.push(`Objekttyp: ${o.objektTyp}`);
    if (o.geplanteVermietung !== null && o.geplanteVermietung !== undefined) lines.push(`Geplante Vermietung: ${o.geplanteVermietung ? 'Ja' : 'Nein'}`);
    if (o.strasse || o.plz || o.ort) {
      lines.push(`Adresse: ${o.strasse || ''} ${o.hausnummer || ''}, ${o.plz || ''} ${o.ort || ''}`);
    }
    if (o.katastralgemeinde) lines.push(`Katastralgemeinde: ${o.katastralgemeinde}`);
    if (o.grundstuecksflaeche) lines.push(`Grundstücksfläche: ${o.grundstuecksflaeche} m²`);
    if (o.baujahr) lines.push(`Baujahr: ${o.baujahr}`);
    if (o.objektImBau) lines.push(`Objekt im Bau: Ja`);
    if (o.baubeginn) lines.push(`Baubeginn: ${new Date(o.baubeginn).toLocaleDateString('de-AT')}`);
    if (o.bauende) lines.push(`Bauende: ${new Date(o.bauende).toLocaleDateString('de-AT')}`);
    if (o.fertigteilbauweise) lines.push(`Fertigteilbauweise: Ja`);
    if (o.energiekennzahl) lines.push(`Energiekennzahl: ${o.energiekennzahl}`);
    if (o.anmerkungen) lines.push(`Anmerkungen Objekt: ${o.anmerkungen}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================
// 2. Text generieren mit Claude
// ============================================================

const STELLUNGNAHME_SYSTEM_PROMPT = `Du bist ein erfahrener österreichischer Vermögensberater und erstellst professionelle Stellungnahmen für Immobilienfinanzierungen, die an Banken bzw. deren Risikomanagement übermittelt werden.

ZIEL:
Die Finanzierung kurz, logisch und professionell darstellen, damit der Bankbearbeiter den Fall schnell versteht und eine positive Kreditentscheidung treffen kann.
Die Stellungnahme soll Vertrauen schaffen und die Stärken der Finanzierung klar hervorheben.

REGELN:
- Schreibe in der dritten Person ("Der Kunde...", "Die Kundin...")
- Verwende einen professionellen, sachlichen, aber positiven Ton
- Die Stellungnahme soll maximal etwa eine Seite lang sein und leicht zu lesen sein
- Da die finalen Kreditkonditionen noch nicht feststehen, soll KEINE monatliche Kreditrate angegeben werden. Stattdessen soll die Tragbarkeit der Finanzierung anhand der Einkommenssituation erklärt werden
- Berechne bei Einkommen immer das monatliche Netto inkl. Sonderzahlungen (Nettolohn * 14/12)
- Formatiere Geldbeträge immer mit Tausenderpunkt und € Symbol (z.B. 250.000 €)
- Nummeriere die Überschriften NICHT, verwende sie als fettgedruckte Überschriften
- Lass Abschnitte weg, die für diesen Kunden nicht relevant sind
- Schreibe KEINEN einleitenden Titel – der wird separat hinzugefügt ("Stellungnahme zur geplanten Finanzierung")

STRUKTUR (nur relevante Abschnitte verwenden):

1. Kurzüberblick Finanzierung
   (Kaufpreis, Eigenmittel, Finanzierungsbedarf, Beleihungsauslauf — kurze Zusammenfassung in 2-3 Sätzen)

2. Kundenprofil
   (Beruf, Arbeitgeber, Beschäftigungsdauer, Einkommen, Familienstand)

3. Einkommensanalyse
   (Nettoeinkommen inkl. Sonderzahlungen, zusätzliche Einnahmen)

4. Haushaltsbetrachtung
   (Tragbarkeit der Finanzierung ohne konkrete Rate — erkläre anhand frei verfügbarem Einkommen)

5. Eigenmittel und Liquidität
   (Höhe, Herkunft, Reserve)

6. Objektanalyse
   (Lage, Zustand, Marktgängigkeit)

7. Sicherheiten
   (Besicherung, Werthaltigkeit)

8. Risikomindernde Faktoren
   (Alles was für eine positive Entscheidung spricht)

9. Empfehlung des Beraters
   (Klare positive Empfehlung mit Begründung)

10. Kundenbestätigung zur Unterschrift
    (Kurzer Absatz: "Der/Die Kreditnehmer bestätigen die Richtigkeit und Vollständigkeit der in dieser Stellungnahme enthaltenen Angaben." + Platzhalter für Datum, Ort und Unterschrift)

Jeder Abschnitt soll 2-4 Sätze lang sein. Sei konkret mit Zahlen wo möglich.

WICHTIG: Gib den Text als reinen Fließtext zurück, OHNE Markdown-Formatierung.
Markiere Überschriften mit dem Prefix "**HEADING**:" auf einer eigenen Zeile, gefolgt vom Überschriftstext.
Der restliche Text folgt als normale Absätze, getrennt durch Leerzeilen.`;

export async function generateStellungnahmeText(leadId: string): Promise<{ text: string; customerName: string }> {
  const data = await gatherCustomerData(leadId);
  const customerDataStr = formatCustomerDataForPrompt(data);

  // Build customer name for display
  const names = data.personen.map((p: any) =>
    `${p.vorname || ''} ${p.nachname || ''}`.trim()
  ).filter(Boolean);
  const customerName = names.join(' & ') || `${data.lead.firstName} ${data.lead.lastName}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: STELLUNGNAHME_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Erstelle eine Stellungnahme zur geplanten Finanzierung für folgenden Kunden:\n\n${customerDataStr}`,
    }],
  });

  const text = (response.content[0] as any).text || '';
  return { text, customerName };
}

// ============================================================
// 3. PDF erstellen
// ============================================================

interface TextSegment {
  type: 'heading' | 'paragraph';
  text: string;
}

function parseStellungnahmeText(rawText: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const lines = rawText.split('\n');
  let currentParagraph = '';

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('**HEADING**:')) {
      // Flush current paragraph
      if (currentParagraph.trim()) {
        segments.push({ type: 'paragraph', text: currentParagraph.trim() });
        currentParagraph = '';
      }
      const heading = trimmed.replace('**HEADING**:', '').trim();
      if (heading) segments.push({ type: 'heading', text: heading });
    } else if (trimmed === '') {
      // Empty line: flush paragraph
      if (currentParagraph.trim()) {
        segments.push({ type: 'paragraph', text: currentParagraph.trim() });
        currentParagraph = '';
      }
    } else {
      currentParagraph += (currentParagraph ? ' ' : '') + trimmed;
    }
  }

  // Flush remaining
  if (currentParagraph.trim()) {
    segments.push({ type: 'paragraph', text: currentParagraph.trim() });
  }

  return segments;
}

// Helper: wrap text to fit within maxWidth, returns array of lines
function wrapText(text: string, font: any, fontSize: number, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const testWidth = font.widthOfTextAtSize(testLine, fontSize);

    if (testWidth > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

export async function createStellungnahmePDF(
  text: string,
  customerName: string,
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 595.28; // A4
  const pageHeight = 841.89;
  const marginLeft = 70;
  const marginRight = 70;
  const marginTop = 70;
  const marginBottom = 70;
  const maxWidth = pageWidth - marginLeft - marginRight;

  const titleFontSize = 14;
  const headingFontSize = 11;
  const bodyFontSize = 10;
  const lineHeight = bodyFontSize * 1.5;
  const headingLineHeight = headingFontSize * 1.6;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - marginTop;

  function ensureSpace(needed: number) {
    if (y - needed < marginBottom) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - marginTop;
    }
  }

  // ── Title ──
  const title = 'Stellungnahme zur geplanten Finanzierung';
  const titleWidth = fontBold.widthOfTextAtSize(title, titleFontSize);
  page.drawText(title, {
    x: (pageWidth - titleWidth) / 2,
    y,
    size: titleFontSize,
    font: fontBold,
    color: rgb(0, 0, 0),
  });
  y -= titleFontSize * 2.5;

  // ── Parse and render ──
  const segments = parseStellungnahmeText(text);

  for (const segment of segments) {
    if (segment.type === 'heading') {
      ensureSpace(headingLineHeight * 2);
      // Extra space before heading
      y -= headingLineHeight * 0.5;

      const headingLines = wrapText(segment.text, fontBold, headingFontSize, maxWidth);
      for (const line of headingLines) {
        ensureSpace(headingLineHeight);
        page.drawText(line, {
          x: marginLeft,
          y,
          size: headingFontSize,
          font: fontBold,
          color: rgb(0, 0, 0),
        });
        y -= headingLineHeight;
      }
      y -= 2; // tiny gap after heading
    } else {
      // Paragraph
      const wrappedLines = wrapText(segment.text, fontRegular, bodyFontSize, maxWidth);
      for (const line of wrappedLines) {
        ensureSpace(lineHeight);
        page.drawText(line, {
          x: marginLeft,
          y,
          size: bodyFontSize,
          font: fontRegular,
          color: rgb(0, 0, 0),
        });
        y -= lineHeight;
      }
      y -= lineHeight * 0.3; // paragraph spacing
    }
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// ============================================================
// 4. PDF in Google Drive hochladen
// ============================================================

export async function uploadStellungnahmeToDrive(
  leadId: string,
  pdfBuffer: Buffer,
  customerName: string,
): Promise<{ fileId: string; webViewLink: string }> {
  // Get the lead's Google Drive folder
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { googleDriveFolderId: true },
  });

  if (!lead?.googleDriveFolderId) {
    throw new Error('Kein Google Drive Ordner für diesen Kunden vorhanden');
  }

  const { google } = await import('googleapis');

  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google Drive OAuth2 credentials not configured');
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  const drive = google.drive({ version: 'v3', auth });

  const dateStr = new Date().toLocaleDateString('de-AT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).replace(/\./g, '-');
  const filename = `Stellungnahme ${customerName} ${dateStr}.pdf`;

  const stream = new Readable();
  stream.push(pdfBuffer);
  stream.push(null);

  const response = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [lead.googleDriveFolderId],
    },
    media: {
      mimeType: 'application/pdf',
      body: stream,
    },
    fields: 'id, webViewLink',
  });

  const fileId = response.data.id!;
  const webViewLink = response.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;

  console.log(`[Stellungnahme] PDF uploaded: ${filename} → ${webViewLink}`);
  return { fileId, webViewLink };
}
