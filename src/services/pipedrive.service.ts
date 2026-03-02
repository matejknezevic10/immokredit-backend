// src/services/pipedrive.service.ts
import { PrismaClient } from '@prisma/client';
import OpenAI from 'openai';

const prisma = new PrismaClient();

const PIPEDRIVE_API_TOKEN = process.env.PIPEDRIVE_API_TOKEN || '';
const PIPEDRIVE_BASE_URL = process.env.PIPEDRIVE_BASE_URL || 'https://api.pipedrive.com/v1';

// Lazy OpenAI init
let openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

// ============================================================
// Email Text Analysis with GPT
// ============================================================

interface EmailAnalysis {
  kreditbetrag: number | null;
  eigenmittel: number | null;
  immobilienart: string | null;
  kaufzeitpunkt: string | null;
}

// Cache to avoid analyzing same email body multiple times
const emailAnalysisCache = new Map<string, EmailAnalysis>();

async function analyzeEmailText(emailBody: string): Promise<EmailAnalysis> {
  if (!emailBody || emailBody.trim().length < 10) {
    return { kreditbetrag: null, eigenmittel: null, immobilienart: null, kaufzeitpunkt: null };
  }

  // Check cache (use first 100 chars as key)
  const cacheKey = emailBody.trim().substring(0, 100);
  const cached = emailAnalysisCache.get(cacheKey);
  if (cached) return cached;

  try {
    const response = await getOpenAI().chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `Du bist ein Assistent für Immobilienfinanzierung. Extrahiere folgende Informationen aus dem Email-Text eines Kunden. Antworte NUR mit einem JSON-Objekt, ohne Markdown.

{
  "kreditbetrag": <Zahl in Euro oder null>,
  "eigenmittel": <Zahl in Euro oder null>,
  "immobilienart": <"Haus", "Wohnung", "Grundstück", "Gewerbe" oder null>,
  "kaufzeitpunkt": <Freitext wie "sofort", "in 3 Monaten", "Sommer 2026" oder null>
}

Regeln:
- Nur Zahlen extrahieren die klar als Kreditbetrag/Eigenmittel gemeint sind
- Bei "250.000€" oder "250000" → 250000
- Bei "250k" → 250000
- Wenn nicht erwähnt → null`
        },
        {
          role: 'user',
          content: emailBody.substring(0, 2000) // Limit to 2000 chars
        }
      ],
    });

    const text = response.choices[0]?.message?.content?.trim() || '{}';
    const cleaned = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(cleaned) as EmailAnalysis;
    
    console.log(`[EmailAnalysis] Extracted: betrag=${result.kreditbetrag}, eigenmittel=${result.eigenmittel}, art=${result.immobilienart}, zeitpunkt=${result.kaufzeitpunkt}`);
    
    emailAnalysisCache.set(cacheKey, result);
    return result;
  } catch (err: any) {
    console.error(`[EmailAnalysis] Failed: ${err.message}`);
    return { kreditbetrag: null, eigenmittel: null, immobilienart: null, kaufzeitpunkt: null };
  }
}

// Required document types for a complete application
const REQUIRED_DOCUMENTS = [
  'REISEPASS',
  'GEHALTSABRECHNUNG',
  'KONTOAUSZUG',
];

// ============================================================
// Helper: Pipedrive API Call
// ============================================================

async function pipedriveRequest(
  method: string,
  endpoint: string,
  body?: Record<string, any>,
): Promise<any> {
  const separator = endpoint.includes('?') ? '&' : '?';
  const url = `${PIPEDRIVE_BASE_URL}${endpoint}${separator}api_token=${PIPEDRIVE_API_TOKEN}`;

  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };

  if (body && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json() as any;

  if (!data.success) {
    throw new Error(`Pipedrive API error: ${data.error || JSON.stringify(data)}`);
  }

  return data.data;
}

// ============================================================
// 1. Find or Create Person in Pipedrive
// ============================================================

async function findOrCreatePerson(
  name: string,
  email?: string | null,
): Promise<{ id: number; isNew: boolean }> {
  // Search by email first (most reliable)
  if (email) {
    try {
      const searchResult = await pipedriveRequest('GET', `/persons/search?term=${encodeURIComponent(email)}&fields=email&limit=1`);
      if (searchResult?.items?.length > 0) {
        const personId = searchResult.items[0].item.id;
        const existingName = searchResult.items[0].item.name;
        
        // Update name if current one is an email address or "Unbekannter Kunde"
        if (name && name !== 'Unbekannter Kunde' && 
            (existingName.includes('@') || existingName === 'Unbekannter Kunde')) {
          await pipedriveRequest('PUT', `/persons/${personId}`, { name });
          console.log(`[Pipedrive] Updated person name: ${existingName} → ${name}`);
        }
        
        return { id: personId, isNew: false };
      }
    } catch (err: any) {
      console.log(`[Pipedrive] Email search failed: ${err.message}`);
    }
  }

  // Search by name
  if (name && name !== 'Unbekannter Kunde') {
    try {
      const nameSearch = await pipedriveRequest('GET', `/persons/search?term=${encodeURIComponent(name)}&limit=5`);
      if (nameSearch?.items?.length > 0) {
        const match = nameSearch.items.find((item: any) =>
          item.item.name.toLowerCase() === name.toLowerCase()
        );
        if (match) {
          return { id: match.item.id, isNew: false };
        }
      }
    } catch (err: any) {
      console.log(`[Pipedrive] Name search failed: ${err.message}`);
    }
  }

  // Create new person
  const person = await pipedriveRequest('POST', '/persons', {
    name,
    email: email ? [{ value: email, primary: true }] : undefined,
  });

  console.log(`[Pipedrive] Created new person: ${name} (ID: ${person.id})`);
  return { id: person.id, isNew: true };
}

// ============================================================
// 2. Find or Create Deal in Pipedrive
// ============================================================

async function findOrCreateDeal(
  personId: number,
  personName: string,
): Promise<{ id: number; isNew: boolean }> {
  // Search for existing open deals for this person
  const deals = await pipedriveRequest('GET', `/persons/${personId}/deals?status=open&limit=5`);

  if (deals && deals.length > 0) {
    return { id: deals[0].id, isNew: false };
  }

  // Get first pipeline and its first stage
  let stageId: number | undefined;
  try {
    const pipelines = await pipedriveRequest('GET', '/pipelines');
    if (pipelines && pipelines.length > 0) {
      const stages = await pipedriveRequest('GET', `/stages?pipeline_id=${pipelines[0].id}`);
      if (stages && stages.length > 0) {
        stageId = stages[0].id;
        console.log(`[Pipedrive] Using stage: ${stages[0].name} (ID: ${stageId})`);
      }
    }
  } catch (err: any) {
    console.error(`[Pipedrive] Could not fetch stages: ${err.message}`);
  }

  // Create new deal
  const dealData: any = {
    title: `Kreditanfrage - ${personName}`,
    person_id: personId,
  };
  if (stageId) dealData.stage_id = stageId;

  const deal = await pipedriveRequest('POST', '/deals', dealData);

  console.log(`[Pipedrive] Created new deal: ${deal.title} (ID: ${deal.id})`);
  return { id: deal.id, isNew: true };
}

// ============================================================
// 3. Add Note to Deal
// ============================================================

async function addNoteToDeal(
  dealId: number,
  content: string,
): Promise<void> {
  await pipedriveRequest('POST', '/notes', {
    deal_id: dealId,
    content,
    pinned_to_deal_flag: 0,
  });
}

// ============================================================
// 4. Create Activity for Follow-up
// ============================================================

async function createActivity(
  dealId: number,
  personId: number,
  subject: string,
  note: string,
  dueDate?: string,
): Promise<void> {
  await pipedriveRequest('POST', '/activities', {
    deal_id: dealId,
    person_id: personId,
    subject,
    note,
    type: 'task',
    due_date: dueDate || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    done: 0,
  });
}

// ============================================================
// 5. Check Document Completeness & Update Deal Stage
// ============================================================

async function checkCompletenessAndUpdateStage(
  leadId: string,
  dealId: number,
): Promise<{ complete: boolean; missing: string[] }> {
  // Get all completed documents for this lead
  const documents = await prisma.document.findMany({
    where: { leadId, ocrStatus: 'COMPLETED' },
    select: { type: true },
  });

  const documentTypes = documents.map((d) => d.type);
  const missing = REQUIRED_DOCUMENTS.filter((req) => !documentTypes.includes(req as any));
  const complete = missing.length === 0;

  if (complete) {
    // Get Pipedrive stages to find "UNTERLAGEN_VOLLSTAENDIG"
    try {
      const pipelines = await pipedriveRequest('GET', '/pipelines?limit=1');
      if (pipelines && pipelines.length > 0) {
        const stages = await pipedriveRequest('GET', `/stages?pipeline_id=${pipelines[0].id}`);
        // Find the stage that matches "Unterlagen vollständig" (4th stage typically)
        const vollstaendigStage = stages?.find((s: any) =>
          s.name.toLowerCase().includes('vollständig') ||
          s.name.toLowerCase().includes('vollstaendig') ||
          s.name.toLowerCase().includes('komplett') ||
          s.order_nr === 3
        );

        if (vollstaendigStage) {
          await pipedriveRequest('PUT', `/deals/${dealId}`, {
            stage_id: vollstaendigStage.id,
          });
          console.log(`[Pipedrive] Deal ${dealId} moved to "${vollstaendigStage.name}"`);
        }
      }
    } catch (err: any) {
      console.error(`[Pipedrive] Stage update failed: ${err.message}`);
    }
  }

  return { complete, missing };
}

// Simple in-memory lock to prevent race conditions when processing multiple attachments
const processingLocks = new Map<string, Promise<void>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // Wait for any existing operation with same key
  const existing = processingLocks.get(key);
  if (existing) {
    await existing;
  }
  
  let resolve: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  processingLocks.set(key, promise);
  
  try {
    return await fn();
  } finally {
    resolve!();
    processingLocks.delete(key);
  }
}

// ============================================================
// MAIN: Process Document in Pipedrive
// ============================================================

export async function processDocumentInPipedrive(params: {
  documentId: string;
  documentType: string;
  documentTypeLabel: string;
  customerName: string | null;
  customerEmail: string | null;
  customerId: string | null;
  emailFrom: string | null;
  ocrConfidence: number;
  filename: string;
  personenNamen?: string[];
  emailBody?: string | null;
}): Promise<void> {
  if (!PIPEDRIVE_API_TOKEN) {
    console.log('[Pipedrive] No API token configured, skipping');
    return;
  }

  const {
    documentId, documentType, documentTypeLabel,
    customerName, customerEmail, customerId,
    emailFrom, ocrConfidence, filename, personenNamen, emailBody,
  } = params;

  // Extract clean email for lock key
  let cleanEmail: string | null = null;
  if (emailFrom) {
    const emailMatch = emailFrom.match(/<(.+?)>/);
    cleanEmail = emailMatch ? emailMatch[1] : emailFrom.includes('@') ? emailFrom : null;
  }
  if (customerEmail) cleanEmail = customerEmail;

  const lockKey = cleanEmail || customerId || documentId;

  // Use lock to serialize requests from same sender
  return withLock(lockKey, async () => {
    try {
      // Determine name: 1) DB match, 2) OCR name, 3) email display name, 4) fallback
      const ocrName = personenNamen && personenNamen.length > 0 ? personenNamen[0] : null;
      let displayName: string | null = null;
      if (emailFrom) {
        const nameMatch = emailFrom.match(/^(.+?)\s*</);
        if (nameMatch) displayName = nameMatch[1].trim();
      }
      const name = customerName || ocrName || displayName || 'Unbekannter Kunde';

      console.log(`[Pipedrive] Processing: ${filename} | name=${name}, email=${cleanEmail}`);

    // 1. Find or create person
    const person = await findOrCreatePerson(name, cleanEmail);
    console.log(`[Pipedrive] Person: ${name} (ID: ${person.id}, new: ${person.isNew})`);

    // 2. Find or create deal
    const deal = await findOrCreateDeal(person.id, name);
    console.log(`[Pipedrive] Deal ID: ${deal.id} (new: ${deal.isNew})`);

    // 2b. Analyze email text for deal details (only once per email)
    if (emailBody && deal.isNew) {
      const emailInfo = await analyzeEmailText(emailBody);
      
      const dealUpdate: any = {};
      if (emailInfo.kreditbetrag) dealUpdate.value = emailInfo.kreditbetrag;
      
      // Build custom note with extracted info
      const infoLines: string[] = [];
      if (emailInfo.kreditbetrag) infoLines.push(`Kreditbetrag: ${emailInfo.kreditbetrag.toLocaleString('de-AT')} €`);
      if (emailInfo.eigenmittel) infoLines.push(`Eigenmittel: ${emailInfo.eigenmittel.toLocaleString('de-AT')} €`);
      if (emailInfo.immobilienart) infoLines.push(`Immobilienart: ${emailInfo.immobilienart}`);
      if (emailInfo.kaufzeitpunkt) infoLines.push(`Kaufzeitpunkt: ${emailInfo.kaufzeitpunkt}`);
      
      if (Object.keys(dealUpdate).length > 0) {
        await pipedriveRequest('PUT', `/deals/${deal.id}`, dealUpdate);
        console.log(`[Pipedrive] Deal value updated: ${emailInfo.kreditbetrag} €`);
      }
      
      if (infoLines.length > 0) {
        const infoNote = `<b>📧 Aus Email extrahiert:</b><br><br>${infoLines.join('<br>')}`;
        await addNoteToDeal(deal.id, infoNote);
        console.log(`[Pipedrive] Email info note added`);
      }
    } else if (emailBody && !deal.isNew) {
      // For existing deals, still analyze but only update value if currently 0
      const emailInfo = await analyzeEmailText(emailBody);
      if (emailInfo.kreditbetrag) {
        try {
          const existingDeal = await pipedriveRequest('GET', `/deals/${deal.id}`);
          if (!existingDeal.value || existingDeal.value === 0) {
            await pipedriveRequest('PUT', `/deals/${deal.id}`, { value: emailInfo.kreditbetrag });
            console.log(`[Pipedrive] Deal value updated (was 0): ${emailInfo.kreditbetrag} €`);
          }
        } catch (err: any) {
          console.log(`[Pipedrive] Could not check/update deal value: ${err.message}`);
        }
      }
    }
    // 3. Add note about received document
    const noteContent = `
<b>📄 Dokument erhalten: ${documentTypeLabel}</b><br>
<br>
Datei: ${filename}<br>
Typ: ${documentTypeLabel}<br>
Konfidenz: ${(ocrConfidence * 100).toFixed(0)}%<br>
Quelle: ${cleanEmail ? `Email von ${cleanEmail}` : 'Manueller Upload'}<br>
Zeitpunkt: ${new Date().toLocaleString('de-AT')}
    `.trim();

    await addNoteToDeal(deal.id, noteContent);
    console.log(`[Pipedrive] Note added to deal ${deal.id}`);

    // 4. Update local DB with Pipedrive IDs
    if (customerId) {
      await prisma.lead.update({
        where: { id: customerId },
        data: {
          pipedrivePersonId: person.id,
          pipedriveDealId: deal.id,
        },
      }).catch(() => {}); // Ignore if fields already set

      // 5. Check completeness and update stage
      const { complete, missing } = await checkCompletenessAndUpdateStage(customerId, deal.id);

      if (complete) {
        // Create activity: all documents complete
        await createActivity(
          deal.id,
          person.id,
          `✅ Alle Unterlagen vollständig - ${name}`,
          'Alle erforderlichen Dokumente (Reisepass, Gehaltszettel, Kontoauszug) sind vorhanden. Kreditanfrage kann bearbeitet werden.',
        );
        console.log(`[Pipedrive] ✅ All documents complete for ${name}`);
      } else {
        // Create activity: follow up on missing documents
        const missingLabels: Record<string, string> = {
          'REISEPASS': 'Reisepass/Ausweis',
          'GEHALTSABRECHNUNG': 'Gehaltszettel',
          'KONTOAUSZUG': 'Kontoauszug',
        };
        const missingList = missing.map((m) => missingLabels[m] || m).join(', ');

        await createActivity(
          deal.id,
          person.id,
          `📋 Fehlende Unterlagen nachfragen - ${name}`,
          `Folgende Dokumente fehlen noch: ${missingList}. Bitte beim Kunden nachfragen.`,
        );
        console.log(`[Pipedrive] Missing documents for ${name}: ${missingList}`);
      }
    } else {
      // No customer matched - create follow-up activity
      await createActivity(
        deal.id,
        person.id,
        `❓ Dokument ohne Kundenzuordnung - ${documentTypeLabel}`,
        `Dokument "${filename}" konnte keinem bestehenden Kunden zugeordnet werden. Bitte manuell prüfen und zuordnen.`,
      );

      if (deal.isNew) {
        console.log(`[Pipedrive] New deal created for unmatched document from ${name}`);
      }
    }

    console.log(`[Pipedrive] ✅ Document processing complete for ${filename}`);
  } catch (err: any) {
    console.error(`[Pipedrive] ❌ Error: ${err.message}`);
  }
  }); // end withLock
}