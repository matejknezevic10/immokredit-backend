// src/services/voiceAgent.service.ts
//
// Voice Agent Service — VAPI.ai Integration
// Initiiert automatisierte Telefonanrufe zur Lead-Qualifizierung.
//
// ENV Variablen:
//   VAPI_API_KEY     — VAPI.ai API Key
//   VAPI_PHONE_ID    — VAPI.ai Phone Number ID (Anrufer-Nummer)
//   BACKEND_URL      — Öffentliche URL für Webhook-Callbacks
//

import { PrismaClient } from '@prisma/client';
import axios from 'axios';

const prisma = new PrismaClient();

const VAPI_BASE_URL = 'https://api.vapi.ai';

// ============================================================
// Qualification Questions — Default für ImmoKredit
// ============================================================
const QUALIFICATION_SYSTEM_PROMPT = `Du bist ein freundlicher und professioneller Finanzberater von ImmoKredit, einem österreichischen Finanzierungsvermittler.
Du rufst den Lead an, um ihn zu qualifizieren. Sei höflich und professionell, sprich Hochdeutsch mit leichtem österreichischem Einschlag.

Dein Ziel:
1. Begrüßung: Stelle dich vor als Berater von ImmoKredit
2. Bestätigung: Bestätige, dass die Person eine Finanzierungsanfrage gestellt hat
3. Stelle diese Qualifizierungsfragen (in natürlicher Reihenfolge):
   - Was für eine Immobilie suchen Sie? (Haus, Wohnung, Grundstück)
   - In welcher Region / welchem Bezirk?
   - Wie hoch ist der ungefähre Kaufpreis?
   - Wie viel Eigenmittel können Sie einbringen?
   - Sind Sie angestellt, selbständig, oder in Pension?
   - Wie hoch ist Ihr monatliches Nettoeinkommen (ca.)?
   - Haben Sie bereits bestehende Kredite oder Leasingverträge?
   - Bis wann möchten Sie die Finanzierung abschließen?
4. Abschluss: Bedanke dich und sage, dass sich ein Berater zeitnah melden wird

Wichtig:
- Wenn die Person nicht reden möchte oder auflegt, beende das Gespräch höflich
- Erzwinge keine Antworten — wenn etwas unklar ist, überspringe die Frage
- Halte das Gespräch kurz (max 3-4 Minuten)
- Sprich IMMER Deutsch`;

const QUALIFICATION_FIRST_MESSAGE = 'Guten Tag! Hier spricht der digitale Berater von ImmoKredit. Sie haben bei uns eine Finanzierungsanfrage gestellt — haben Sie kurz Zeit für ein paar Fragen?';

// ============================================================
// Anruf starten
// ============================================================
export interface InitiateCallParams {
  leadId: string;
  phoneNumber: string;
  leadName: string;
}

export interface InitiateCallResult {
  success: boolean;
  callId?: string;
  error?: string;
}

export async function initiateVoiceAgentCall(params: InitiateCallParams): Promise<InitiateCallResult> {
  const { leadId, phoneNumber, leadName } = params;
  const apiKey = process.env.VAPI_API_KEY;

  if (!apiKey) {
    return { success: false, error: 'VAPI_API_KEY nicht konfiguriert' };
  }

  const phoneNumberId = process.env.VAPI_PHONE_ID;
  if (!phoneNumberId) {
    return { success: false, error: 'VAPI_PHONE_ID nicht konfiguriert' };
  }

  const backendUrl = (process.env.BACKEND_URL || 'http://localhost:4000').replace(/\/$/, '');

  try {
    const response = await axios.post(
      `${VAPI_BASE_URL}/call/phone`,
      {
        phoneNumberId,
        customer: {
          number: phoneNumber,
          name: leadName,
        },
        assistant: {
          model: {
            provider: 'openai',
            model: 'gpt-4o',
            messages: [
              {
                role: 'system',
                content: QUALIFICATION_SYSTEM_PROMPT,
              },
            ],
          },
          voice: {
            provider: 'azure',
            voiceId: 'de-AT-JonasNeural',
          },
          firstMessage: QUALIFICATION_FIRST_MESSAGE,
          endCallMessage: 'Vielen Dank für Ihre Zeit! Ein Berater von ImmoKredit wird sich bald bei Ihnen melden. Auf Wiederhören!',
          transcriber: {
            provider: 'deepgram',
            model: 'nova-2',
            language: 'de',
          },
          serverUrl: `${backendUrl}/api/voice-agent/webhook`,
          endCallFunctionEnabled: true,
          maxDurationSeconds: 300, // 5 min max
          silenceTimeoutSeconds: 30,
        },
        metadata: {
          leadId,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      },
    );

    const callId = response.data.id;

    // Log activity
    await prisma.activity.create({
      data: {
        leadId,
        type: 'WORKFLOW_TRIGGERED',
        title: 'Voice Agent Anruf gestartet',
        description: `Automatischer Qualifizierungsanruf an ${phoneNumber}`,
        data: { callId, phoneNumber },
      },
    });

    console.log(`[VoiceAgent] Call initiated: ${callId} → ${phoneNumber}`);
    return { success: true, callId };
  } catch (err: any) {
    const errorMsg = err.response?.data?.message || err.message;
    console.error(`[VoiceAgent] Call failed:`, errorMsg);

    await prisma.activity.create({
      data: {
        leadId,
        type: 'WORKFLOW_TRIGGERED',
        title: 'Voice Agent Anruf fehlgeschlagen',
        description: errorMsg,
        data: { error: errorMsg, phoneNumber },
      },
    });

    return { success: false, error: errorMsg };
  }
}

// ============================================================
// VAPI Webhook verarbeiten
// ============================================================
export interface VapiWebhookPayload {
  message: {
    type: string;
    call?: any;
    transcript?: string;
    summary?: string;
    endedReason?: string;
    recordingUrl?: string;
    analysis?: any;
    artifact?: any;
  };
}

export async function processVapiWebhook(payload: VapiWebhookPayload): Promise<void> {
  const { message } = payload;
  const type = message.type;

  console.log(`[VoiceAgent] Webhook: ${type}`);

  if (type === 'end-of-call-report') {
    const call = message.call || message;
    const leadId = call?.metadata?.leadId || message?.artifact?.metadata?.leadId;

    if (!leadId) {
      console.warn('[VoiceAgent] No leadId in webhook payload');
      return;
    }

    const transcript = message.transcript || message.artifact?.transcript || '';
    const summary = message.summary || message.artifact?.summary || '';
    const duration = call?.duration || call?.costBreakdown?.duration || 0;
    const endedReason = message.endedReason || call?.endedReason || 'unknown';
    const recordingUrl = message.recordingUrl || message.artifact?.recordingUrl || null;

    // Parse structured data from the call
    const qualificationData = extractQualificationData(transcript, summary);

    // Update lead with qualification data
    const updateData: any = {};
    if (qualificationData.amount) updateData.amount = qualificationData.amount;
    if (qualificationData.message) updateData.message = qualificationData.message;

    // Set lead quality based on call outcome
    if (endedReason === 'assistant-ended' || endedReason === 'customer-ended') {
      // Good call — lead engaged
      updateData.temperatur = 'HOT';
      updateData.score = Math.min(100, 60 + (qualificationData.answeredQuestions * 5));
    } else if (endedReason === 'silence-timed-out' || endedReason === 'no-answer') {
      updateData.temperatur = 'COLD';
      updateData.score = 10;
    }

    if (Object.keys(updateData).length > 0) {
      await prisma.lead.update({
        where: { id: leadId },
        data: updateData,
      });
    }

    // Try to move deal to QUALIFIZIERT
    if (qualificationData.answeredQuestions >= 3) {
      const deal = await prisma.deal.findUnique({ where: { leadId } });
      if (deal && deal.stage === 'NEUER_LEAD') {
        await prisma.deal.update({
          where: { id: deal.id },
          data: { stage: 'QUALIFIZIERT' },
        });

        await prisma.activity.create({
          data: {
            leadId,
            type: 'DEAL_MOVED',
            title: 'Deal nach Qualifizierung verschoben',
            description: 'Voice Agent hat den Lead erfolgreich qualifiziert → QUALIFIZIERT',
          },
        });
      }
    }

    // Log completion
    await prisma.activity.create({
      data: {
        leadId,
        type: 'WORKFLOW_TRIGGERED',
        title: `Voice Agent Anruf ${endedReason === 'no-answer' ? 'nicht erreicht' : 'abgeschlossen'}`,
        description: summary || `Dauer: ${Math.round(duration)}s, ${qualificationData.answeredQuestions} Fragen beantwortet`,
        data: {
          transcript: transcript.substring(0, 5000),
          summary,
          duration,
          endedReason,
          recordingUrl,
          qualification: JSON.parse(JSON.stringify(qualificationData)),
        },
      },
    });

    console.log(`[VoiceAgent] Call completed for lead ${leadId}: ${endedReason}, ${qualificationData.answeredQuestions} questions answered`);
  }
}

// ============================================================
// Qualifizierungsdaten aus Transkript extrahieren
// ============================================================
interface QualificationData {
  immobilienTyp: string | null;
  region: string | null;
  kaufpreis: number | null;
  eigenmittel: number | null;
  beschaeftigung: string | null;
  nettoeinkommen: number | null;
  bestandskredite: boolean | null;
  zeitrahmen: string | null;
  answeredQuestions: number;
  amount: number | null;
  message: string;
}

function extractQualificationData(transcript: string, summary: string): QualificationData {
  const text = `${transcript}\n${summary}`.toLowerCase();
  let answeredQuestions = 0;

  // Immobilientyp
  let immobilienTyp: string | null = null;
  if (/wohnung|eigentumswohnung|apartment/.test(text)) { immobilienTyp = 'Wohnung'; answeredQuestions++; }
  else if (/haus|einfamilienhaus|reihenhaus|doppelhaus/.test(text)) { immobilienTyp = 'Haus'; answeredQuestions++; }
  else if (/grundst[uü]ck|bauplatz/.test(text)) { immobilienTyp = 'Grundstück'; answeredQuestions++; }

  // Region
  let region: string | null = null;
  const regionMatch = text.match(/(?:bezirk|region|in )([\w\sößäü-]+?)(?:\.|,|\n|und|wo)/i);
  if (regionMatch) { region = regionMatch[1].trim(); answeredQuestions++; }

  // Kaufpreis
  let kaufpreis: number | null = null;
  const preisMatch = text.match(/(\d[\d.,]*)\s*(?:tausend|\.000|k)?\s*(?:euro|€)/i);
  if (preisMatch) {
    let val = parseFloat(preisMatch[1].replace(/\./g, '').replace(',', '.'));
    if (val < 10000) val *= 1000; // "300 tausend" → 300000
    kaufpreis = val;
    answeredQuestions++;
  }

  // Eigenmittel
  let eigenmittel: number | null = null;
  const eigenMatch = text.match(/eigenmittel.*?(\d[\d.,]*)/i) || text.match(/(\d[\d.,]*)\s*(?:euro|€)?\s*eigenmittel/i);
  if (eigenMatch) {
    let val = parseFloat(eigenMatch[1].replace(/\./g, '').replace(',', '.'));
    if (val < 10000) val *= 1000;
    eigenmittel = val;
    answeredQuestions++;
  }

  // Beschäftigung
  let beschaeftigung: string | null = null;
  if (/angestellt|arbeitnehmer|unselbst[aä]ndig/.test(text)) { beschaeftigung = 'Angestellt'; answeredQuestions++; }
  else if (/selbst[sä]ndig|freiberuflich|unternehmer/.test(text)) { beschaeftigung = 'Selbständig'; answeredQuestions++; }
  else if (/pension|rente|ruhestand/.test(text)) { beschaeftigung = 'Pension'; answeredQuestions++; }

  // Nettoeinkommen
  let nettoeinkommen: number | null = null;
  const einkommenMatch = text.match(/(?:netto|einkommen|verdien).*?(\d[\d.,]*)/i);
  if (einkommenMatch) {
    nettoeinkommen = parseFloat(einkommenMatch[1].replace(/\./g, '').replace(',', '.'));
    answeredQuestions++;
  }

  // Bestandskredite
  let bestandskredite: boolean | null = null;
  if (/kein.*kredit|keine.*kredit|nein.*kredit|keine.*leasing/.test(text)) { bestandskredite = false; answeredQuestions++; }
  else if (/kredit.*lauf|leasing|bestehend.*kredit|ja.*kredit/.test(text)) { bestandskredite = true; answeredQuestions++; }

  // Zeitrahmen
  let zeitrahmen: string | null = null;
  const zeitMatch = text.match(/(?:bis |in |innerhalb )([\w\sößäü-]+?)(?:möchte|wollen|abschlie|finanzier)/i);
  if (zeitMatch) { zeitrahmen = zeitMatch[1].trim(); answeredQuestions++; }

  // Build summary message
  const parts: string[] = ['Qualifizierung per Voice Agent:'];
  if (immobilienTyp) parts.push(`Immobilie: ${immobilienTyp}`);
  if (region) parts.push(`Region: ${region}`);
  if (kaufpreis) parts.push(`Kaufpreis: ca. €${kaufpreis.toLocaleString()}`);
  if (eigenmittel) parts.push(`Eigenmittel: ca. €${eigenmittel.toLocaleString()}`);
  if (beschaeftigung) parts.push(`Beschäftigung: ${beschaeftigung}`);
  if (nettoeinkommen) parts.push(`Netto-Einkommen: ca. €${nettoeinkommen.toLocaleString()}`);
  if (bestandskredite !== null) parts.push(`Bestandskredite: ${bestandskredite ? 'Ja' : 'Nein'}`);
  if (zeitrahmen) parts.push(`Zeitrahmen: ${zeitrahmen}`);

  return {
    immobilienTyp,
    region,
    kaufpreis,
    eigenmittel,
    beschaeftigung,
    nettoeinkommen,
    bestandskredite,
    zeitrahmen,
    answeredQuestions,
    amount: kaufpreis,
    message: parts.join('\n'),
  };
}

// ============================================================
// Anruf-Status abfragen
// ============================================================
export async function getCallStatus(callId: string): Promise<any> {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await axios.get(`${VAPI_BASE_URL}/call/${callId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return response.data;
  } catch {
    return null;
  }
}
