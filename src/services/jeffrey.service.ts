// src/services/jeffrey.service.ts
//
// Jeffrey Agent – Intelligenter Dokumenten-Check & Email-Generator
// Prüft welche Unterlagen pro Lead vorhanden sind und generiert
// professionelle Erinnerungs-Emails für fehlende Dokumente.
//

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ============================================================
// Complete document checklist for ImmoKredit financing
// ============================================================

export interface ChecklistItem {
  id: string;
  label: string;
  category: 'PERSOENLICH' | 'IMMOBILIE';
  required: boolean; // true = Pflicht, false = falls vorhanden
  matchTypes: string[]; // Prisma document types that satisfy this item
  matchKeywords: string[]; // Keywords in filename/OCR to match
}

export const DOCUMENT_CHECKLIST: ChecklistItem[] = [
  // ── Persönliche Unterlagen ──
  {
    id: 'ausweis',
    label: 'Ausweis',
    category: 'PERSOENLICH',
    required: true,
    matchTypes: ['REISEPASS', 'AUSWEIS'],
    matchKeywords: ['ausweis', 'reisepass', 'passport', 'personalausweis', 'identität'],
  },
  {
    id: 'meldezettel',
    label: 'Meldezettel',
    category: 'PERSOENLICH',
    required: true,
    matchTypes: ['MELDEZETTEL'],
    matchKeywords: ['meldezettel', 'meldebescheinigung', 'meldebestätigung', 'zentrales melderegister'],
  },
  {
    id: 'lohnzettel',
    label: 'Letzten 3–6 Lohnzettel',
    category: 'PERSOENLICH',
    required: true,
    matchTypes: ['GEHALTSABRECHNUNG'],
    matchKeywords: ['lohnzettel', 'lohnabrechnung', 'gehaltszettel', 'gehaltsabrechnung', 'bezugszettel', 'entgeltabrechnung'],
  },
  {
    id: 'jahreslohnzettel',
    label: 'Jahreslohnzettel',
    category: 'PERSOENLICH',
    required: true,
    matchTypes: ['JAHRESLOHNZETTEL'],
    matchKeywords: ['jahreslohnzettel', 'lohnzettel jahres', 'jahreslohn', 'l16', 'lohnzettel jährl'],
  },
  {
    id: 'familienbeihilfe',
    label: 'Familienbeihilfe, Kindergeld, Karenz usw.',
    category: 'PERSOENLICH',
    required: false,
    matchTypes: ['FAMILIENBEIHILFE'],
    matchKeywords: ['familienbeihilfe', 'kindergeld', 'karenz', 'kinderbetreuungsgeld', 'beihilfe'],
  },
  {
    id: 'eigenmittelnachweis',
    label: 'Eigenmittelnachweis',
    category: 'PERSOENLICH',
    required: true,
    matchTypes: ['EIGENMITTELNACHWEIS'],
    matchKeywords: ['eigenmittel', 'eigenkapital', 'sparbuch', 'bausparvertrag', 'depotauszug', 'wertpapier'],
  },
  {
    id: 'restschuld',
    label: 'Restschuld aller Kredite auch Leasing',
    category: 'PERSOENLICH',
    required: true,
    matchTypes: ['RESTSCHULD'],
    matchKeywords: ['restschuld', 'kreditbestätigung', 'kreditvertrag', 'leasing', 'kreditauskunft', 'verbindlichkeiten'],
  },
  {
    id: 'kontoauszug',
    label: 'Kontoauszug 3 Monate mit Saldo',
    category: 'PERSOENLICH',
    required: true,
    matchTypes: ['KONTOAUSZUG'],
    matchKeywords: ['kontoauszug', 'kontoauszüge', 'bankauszug', 'kontobewegung', 'saldo'],
  },
  {
    id: 'sozialversicherung',
    label: 'Sozialversicherungsauszug',
    category: 'PERSOENLICH',
    required: true,
    matchTypes: ['SOZIALVERSICHERUNGSAUSZUG'],
    matchKeywords: ['sozialversicherung', 'sv-auszug', 'versicherungsdatenauszug', 'sozialversicherungsauszug'],
  },

  // ── Immobilien Unterlagen ──
  {
    id: 'grundbuchauszug',
    label: 'Grundbuchauszug',
    category: 'IMMOBILIE',
    required: true,
    matchTypes: ['GRUNDBUCHAUSZUG'],
    matchKeywords: ['grundbuch', 'grundbuchauszug', 'grundbuchsauszug', 'tagebuchzahl'],
  },
  {
    id: 'plan',
    label: 'Plan (leserlich mit m²)',
    category: 'IMMOBILIE',
    required: true,
    matchTypes: ['PLAN'],
    matchKeywords: ['plan', 'grundriss', 'wohnfläche', 'bauplan', 'geschossplan'],
  },
  {
    id: 'lageplan',
    label: 'Lageplan, Adresse',
    category: 'IMMOBILIE',
    required: true,
    matchTypes: ['LAGEPLAN'],
    matchKeywords: ['lageplan', 'katasterplan', 'flurkarte', 'liegenschaftsplan'],
  },
  {
    id: 'fotos',
    label: 'Fotos (innen & außen)',
    category: 'IMMOBILIE',
    required: true,
    matchTypes: ['FOTOS'],
    matchKeywords: ['foto', 'fotos', 'bild', 'bilder', 'innen', 'außen', 'immobilienfoto'],
  },
  {
    id: 'energieausweis',
    label: 'Energieausweis',
    category: 'IMMOBILIE',
    required: false,
    matchTypes: ['ENERGIEAUSWEIS'],
    matchKeywords: ['energieausweis', 'energiekennzahl', 'hwb', 'energieeffizienz'],
  },
  {
    id: 'nutzwertgutachten',
    label: 'Nutzwertgutachten',
    category: 'IMMOBILIE',
    required: false,
    matchTypes: ['NUTZWERTGUTACHTEN'],
    matchKeywords: ['nutzwert', 'nutzwertgutachten', 'gutachten'],
  },
  {
    id: 'kontaktdaten_verkaeufer',
    label: 'Kontaktdaten Verkäufer / Makler',
    category: 'IMMOBILIE',
    required: true,
    matchTypes: ['KONTAKTDATEN_VERKAEUFER'],
    matchKeywords: ['verkäufer', 'makler', 'kontaktdaten verkäufer', 'maklerdaten'],
  },
  {
    id: 'expose',
    label: 'Exposé',
    category: 'IMMOBILIE',
    required: true,
    matchTypes: ['EXPOSE'],
    matchKeywords: ['exposé', 'expose', 'objektbeschreibung', 'immobilienexposé'],
  },
];

// ============================================================
// Check which documents a lead has / is missing
// ============================================================

export interface DocumentCheckResult {
  leadId: string;
  leadName: string;
  leadEmail: string;
  totalRequired: number;
  totalPresent: number;
  completionPercent: number;
  present: { id: string; label: string; category: string; documentId?: string; filename?: string }[];
  missing: { id: string; label: string; category: string; required: boolean }[];
  missingRequired: { id: string; label: string; category: string }[];
  missingOptional: { id: string; label: string; category: string }[];
}

export async function checkDocuments(leadId: string): Promise<DocumentCheckResult> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      documents: {
        where: { ocrStatus: 'COMPLETED' },
        select: { id: true, type: true, filename: true, originalFilename: true, extractedData: true },
      },
    },
  });

  if (!lead) throw new Error('Lead not found');

  const present: DocumentCheckResult['present'] = [];
  const missing: DocumentCheckResult['missing'] = [];

  for (const item of DOCUMENT_CHECKLIST) {
    // Check by document type
    let matched = lead.documents.find(doc =>
      item.matchTypes.includes(doc.type)
    );

    // Check by filename keywords if not matched by type
    if (!matched) {
      matched = lead.documents.find(doc => {
        const filename = (doc.originalFilename || doc.filename || '').toLowerCase();
        return item.matchKeywords.some(kw => filename.includes(kw));
      });
    }

    if (matched) {
      present.push({
        id: item.id,
        label: item.label,
        category: item.category,
        documentId: matched.id,
        filename: matched.originalFilename || matched.filename,
      });
    } else {
      missing.push({
        id: item.id,
        label: item.label,
        category: item.category,
        required: item.required,
      });
    }
  }

  const requiredItems = DOCUMENT_CHECKLIST.filter(i => i.required);
  const presentRequired = present.filter(p => {
    const item = DOCUMENT_CHECKLIST.find(c => c.id === p.id);
    return item?.required;
  });

  return {
    leadId: lead.id,
    leadName: `${lead.firstName} ${lead.lastName}`,
    leadEmail: lead.email,
    totalRequired: requiredItems.length,
    totalPresent: presentRequired.length,
    completionPercent: Math.round((presentRequired.length / requiredItems.length) * 100),
    present,
    missing,
    missingRequired: missing.filter(m => m.required),
    missingOptional: missing.filter(m => !m.required),
  };
}

// ============================================================
// Generate reminder email text for missing documents
// ============================================================

export interface GeneratedEmail {
  subject: string;
  body: string;
  bodyHtml: string;
  missingCount: number;
  leadName: string;
  leadEmail: string;
}

export function generateReminderEmail(checkResult: DocumentCheckResult): GeneratedEmail {
  const { leadName, leadEmail, missingRequired, missingOptional, completionPercent } = checkResult;
  const firstName = leadName.split(' ')[0];

  // Group missing by category
  const missingPersoenlich = missingRequired.filter(m => m.category === 'PERSOENLICH');
  const missingImmobilie = missingRequired.filter(m => m.category === 'IMMOBILIE');

  // Build email body
  let body = `Sehr geehrte/r ${firstName},\n\n`;
  body += `vielen Dank für Ihre Finanzierungsanfrage bei ImmoKredit.\n\n`;

  if (missingRequired.length === 0) {
    body += `Wir freuen uns, Ihnen mitzuteilen, dass alle erforderlichen Unterlagen vollständig bei uns eingegangen sind. `;
    body += `Wir werden Ihre Anfrage nun zeitnah bearbeiten und uns mit einem individuellen Angebot bei Ihnen melden.\n\n`;
  } else {
    body += `Um Ihre Finanzierung schnellstmöglich bearbeiten zu können, benötigen wir noch folgende Unterlagen von Ihnen:\n\n`;

    if (missingPersoenlich.length > 0) {
      body += `📋 Persönliche Unterlagen:\n`;
      for (const doc of missingPersoenlich) {
        body += `  • ${doc.label}\n`;
      }
      body += `\n`;
    }

    if (missingImmobilie.length > 0) {
      body += `🏠 Immobilien Unterlagen:\n`;
      for (const doc of missingImmobilie) {
        body += `  • ${doc.label}\n`;
      }
      body += `\n`;
    }

    if (missingOptional.length > 0) {
      body += `Falls vorhanden, wären auch hilfreich:\n`;
      for (const doc of missingOptional) {
        body += `  • ${doc.label}\n`;
      }
      body += `\n`;
    }

    body += `Bitte senden Sie die Unterlagen einfach als Antwort auf diese E-Mail oder als Foto/Scan an unsere E-Mail-Adresse.\n\n`;
    body += `Aktueller Stand: ${completionPercent}% der erforderlichen Unterlagen sind vorhanden.\n\n`;
  }

  body += `Bei Fragen stehen wir Ihnen jederzeit gerne zur Verfügung.\n\n`;
  body += `Mit freundlichen Grüßen\n`;
  body += `Ihr ImmoKredit Team\n`;
  body += `📞 +43 664 35 17 810\n`;
  body += `✉️ info@immo-kredit.net`;

  // HTML version
  let bodyHtml = `<div style="font-family: Arial, sans-serif; font-size: 15px; color: #333; line-height: 1.6;">`;
  bodyHtml += `<p>Sehr geehrte/r ${firstName},</p>`;
  bodyHtml += `<p>vielen Dank für Ihre Finanzierungsanfrage bei <strong>ImmoKredit</strong>.</p>`;

  if (missingRequired.length === 0) {
    bodyHtml += `<p>Wir freuen uns, Ihnen mitzuteilen, dass alle erforderlichen Unterlagen vollständig bei uns eingegangen sind. Wir werden Ihre Anfrage nun zeitnah bearbeiten und uns mit einem individuellen Angebot bei Ihnen melden.</p>`;
  } else {
    bodyHtml += `<p>Um Ihre Finanzierung schnellstmöglich bearbeiten zu können, benötigen wir noch folgende Unterlagen von Ihnen:</p>`;

    if (missingPersoenlich.length > 0) {
      bodyHtml += `<p style="margin-bottom:4px"><strong>📋 Persönliche Unterlagen:</strong></p><ul style="margin-top:0">`;
      for (const doc of missingPersoenlich) {
        bodyHtml += `<li>${doc.label}</li>`;
      }
      bodyHtml += `</ul>`;
    }

    if (missingImmobilie.length > 0) {
      bodyHtml += `<p style="margin-bottom:4px"><strong>🏠 Immobilien Unterlagen:</strong></p><ul style="margin-top:0">`;
      for (const doc of missingImmobilie) {
        bodyHtml += `<li>${doc.label}</li>`;
      }
      bodyHtml += `</ul>`;
    }

    if (missingOptional.length > 0) {
      bodyHtml += `<p style="margin-bottom:4px"><em>Falls vorhanden, wären auch hilfreich:</em></p><ul style="margin-top:0">`;
      for (const doc of missingOptional) {
        bodyHtml += `<li>${doc.label}</li>`;
      }
      bodyHtml += `</ul>`;
    }

    bodyHtml += `<p>Bitte senden Sie die Unterlagen einfach als Antwort auf diese E-Mail oder als Foto/Scan an unsere E-Mail-Adresse.</p>`;
    bodyHtml += `<p style="background:#f0f7ff; padding:12px 16px; border-radius:8px; display:inline-block;">📊 Aktueller Stand: <strong>${completionPercent}%</strong> der erforderlichen Unterlagen vorhanden</p>`;
  }

  bodyHtml += `<p>Bei Fragen stehen wir Ihnen jederzeit gerne zur Verfügung.</p>`;
  bodyHtml += `<p>Mit freundlichen Grüßen<br/><strong>Ihr ImmoKredit Team</strong><br/>📞 +43 664 35 17 810<br/>✉️ info@immo-kredit.net</p>`;
  bodyHtml += `</div>`;

  const subject = missingRequired.length === 0
    ? `ImmoKredit – Ihre Unterlagen sind vollständig ✅`
    : `ImmoKredit – Noch ${missingRequired.length} Unterlage${missingRequired.length > 1 ? 'n' : ''} benötigt`;

  return {
    subject,
    body,
    bodyHtml,
    missingCount: missingRequired.length,
    leadName,
    leadEmail,
  };
}

// ============================================================
// All-in-one: Check documents + generate email for a lead
// ============================================================

export async function generateMissingDocsEmail(leadId: string): Promise<{
  check: DocumentCheckResult;
  email: GeneratedEmail;
}> {
  const check = await checkDocuments(leadId);
  const email = generateReminderEmail(check);

  // Log activity
  await prisma.activity.create({
    data: {
      leadId,
      type: 'NOTE_ADDED',
      title: 'Jeffrey: Unterlagen-Erinnerung generiert',
      description: `${check.missingRequired.length} fehlende Pflicht-Unterlagen, ${check.completionPercent}% vollständig`,
    },
  });

  return { check, email };
}