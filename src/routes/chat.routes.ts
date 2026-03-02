// src/routes/chat.routes.ts
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import OpenAI from 'openai';

const router = Router();
const prisma = new PrismaClient();

let openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

// Gather context from DB based on the user's question
async function gatherContext(question: string): Promise<string> {
  const q = question.toLowerCase();
  const contextParts: string[] = [];

  // Always load leads summary
  const leads = await prisma.lead.findMany({
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      source: true,
      amount: true,
      ampelStatus: true,
      temperatur: true,
      score: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  if (leads.length > 0) {
    contextParts.push('=== LEADS/KUNDEN ===');
    leads.forEach((l) => {
      contextParts.push(
        `- ${l.firstName} ${l.lastName} | Email: ${l.email} | Tel: ${l.phone} | Quelle: ${l.source} | Betrag: ${l.amount || 'k.A.'} | Ampel: ${l.ampelStatus} | Temperatur: ${l.temperatur} | Score: ${l.score} | Erstellt: ${l.createdAt.toISOString().split('T')[0]}`
      );
    });
  }

  // Load documents with extracted data
  const documents = await prisma.document.findMany({
    select: {
      id: true,
      filename: true,
      type: true,
      extractedData: true,
      ocrConfidence: true,
      emailFrom: true,
      uploadedAt: true,
      lead: {
        select: { firstName: true, lastName: true },
      },
    },
    where: { ocrStatus: 'COMPLETED' },
    orderBy: { uploadedAt: 'desc' },
    take: 100,
  });

  if (documents.length > 0) {
    contextParts.push('\n=== DOKUMENTE (mit OCR-Daten) ===');
    documents.forEach((d) => {
      const leadName = d.lead ? `${d.lead.firstName} ${d.lead.lastName}` : 'Nicht zugeordnet';
      const extracted = d.extractedData ? JSON.stringify(d.extractedData) : 'keine Daten';
      contextParts.push(
        `- ${d.type}: ${d.filename} | Kunde: ${leadName} | Von: ${d.emailFrom || 'Upload'} | Datum: ${d.uploadedAt.toISOString().split('T')[0]} | Daten: ${extracted}`
      );
    });
  }

  // Load deals if question seems deal-related
  if (q.includes('deal') || q.includes('pipeline') || q.includes('fehlt') || q.includes('unterlage') || q.includes('status') || q.includes('vollständig')) {
    const deals = await prisma.deal.findMany({
      select: {
        id: true,
        title: true,
        value: true,
        stage: true,
        createdAt: true,
        lead: {
          select: { firstName: true, lastName: true, email: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    if (deals.length > 0) {
      contextParts.push('\n=== DEALS ===');
      deals.forEach((d) => {
        const leadName = d.lead ? `${d.lead.firstName} ${d.lead.lastName}` : 'Unbekannt';
        contextParts.push(
          `- ${d.title} | Kunde: ${leadName} | Wert: ${d.value}€ | Stage: ${d.stage} | Erstellt: ${d.createdAt.toISOString().split('T')[0]}`
        );
      });
    }

    // Check document completeness per lead
    const REQUIRED_DOCS = ['REISEPASS', 'GEHALTSABRECHNUNG', 'KONTOAUSZUG'];
    contextParts.push('\n=== DOKUMENTEN-VOLLSTÄNDIGKEIT ===');
    
    for (const lead of leads.slice(0, 20)) {
      const leadDocs = await prisma.document.findMany({
        where: { leadId: lead.id, ocrStatus: 'COMPLETED' },
        select: { type: true },
      });
      const docTypes = leadDocs.map((d) => d.type as string);
      const missing = REQUIRED_DOCS.filter((r) => !docTypes.includes(r));
      const status = missing.length === 0 ? '✅ Vollständig' : `❌ Fehlt: ${missing.join(', ')}`;
      contextParts.push(`- ${lead.firstName} ${lead.lastName}: ${status} (vorhanden: ${docTypes.join(', ') || 'keine'})`);
    }
  }

  // Recent activities
  const activities = await prisma.activity.findMany({
    orderBy: { createdAt: 'desc' },
    take: 15,
    select: {
      type: true,
      title: true,
      description: true,
      createdAt: true,
      lead: { select: { firstName: true, lastName: true } },
    },
  });

  if (activities.length > 0) {
    contextParts.push('\n=== LETZTE AKTIVITÄTEN ===');
    activities.forEach((a) => {
      const leadName = a.lead ? `${a.lead.firstName} ${a.lead.lastName}` : '';
      contextParts.push(
        `- ${a.createdAt.toISOString().split('T')[0]}: ${a.title} ${leadName ? `(${leadName})` : ''}`
      );
    });
  }

  return contextParts.join('\n');
}

// POST /api/chat
router.post('/', async (req: Request, res: Response) => {
  try {
    const { message, history } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Nachricht erforderlich' });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OpenAI API Key nicht konfiguriert' });
    }

    console.log(`[Jeffrey] Frage: ${message}`);

    // Gather DB context
    const context = await gatherContext(message);

    // Build messages
    const systemPrompt = `Du bist Jeffrey, ein freundlicher und kompetenter AI-Assistent für ImmoKredit - eine Immobilien-Finanzierungsplattform. Du hilfst den Mitarbeitern bei ihrer täglichen Arbeit.

Deine Fähigkeiten:
- Du hast Zugriff auf alle Kunden-, Dokumenten- und Deal-Daten der Plattform
- Du kannst Informationen aus OCR-extrahierten Dokumenten (Reisepässe, Gehaltszettel, Kontoauszüge) abrufen
- Du kannst den Status von Kreditanfragen und fehlende Unterlagen prüfen
- Du kannst Dokumente zusammenfassen und Kundeninformationen herausfiltern
- Du beantwortest allgemeine Fragen zum Finanzierungsprozess

Regeln:
- Antworte immer auf Deutsch
- Sei präzise und hilfreich
- Wenn du Daten aus dem System zitierst, nenne die Quelle (z.B. "laut Reisepass" oder "aus dem Gehaltszettel")
- Wenn du etwas nicht weißt oder die Daten nicht vorhanden sind, sage das ehrlich
- Halte Antworten kurz und übersichtlich
- Verwende Emojis sparsam aber gezielt

Hier sind die aktuellen Daten aus dem System:

${context}`;

    const messages: any[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Add conversation history (last 10 messages)
    if (history && Array.isArray(history)) {
      history.slice(-10).forEach((h: any) => {
        messages.push({ role: h.role, content: h.content });
      });
    }

    messages.push({ role: 'user', content: message });

    const response = await getOpenAI().chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      max_tokens: 1000,
      messages,
    });

    const reply = response.choices[0]?.message?.content || 'Entschuldigung, ich konnte keine Antwort generieren.';

    console.log(`[Jeffrey] Antwort: ${reply.substring(0, 100)}...`);

    res.json({ reply });
  } catch (error: any) {
    console.error('[Jeffrey] Error:', error.message);
    res.status(500).json({ error: 'Jeffrey ist gerade nicht verfügbar. Bitte versuche es später.' });
  }
});

export default router;