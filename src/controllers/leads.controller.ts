// src/controllers/leads.controller.ts
import { Request, Response } from 'express';
import { PrismaClient, AmpelStatus, Temperatur } from '@prisma/client';
import { leadsService } from '../services/leads.service';
import { createCustomerFolder } from '../services/googleDrive.service';
import { pipedriveService } from '../integrations/pipedrive.service';
import { AuthRequest } from '../middleware/auth.middleware';

const prisma = new PrismaClient();

// ============================================================
// Scoring-Logik basierend auf Funnel-Antworten (PDF v2 mit Korrekturen)
// 6 von 10 Fragen fließen in den Score ein.
// Max Rohpunkte = 123, normalisiert auf 100.
// ============================================================
function calculateScoreFromFunnelAnswers(funnelAnswers: any): { score: number; temperatur: Temperatur; ampelStatus: AmpelStatus } {
  if (!funnelAnswers) return { score: 0, temperatur: Temperatur.WARM, ampelStatus: AmpelStatus.YELLOW };

  let rawScore = 0;
  const fa = funnelAnswers;

  // 1. Finanzierungsart (max 8 Pkt)
  const finanzierungsartMap: Record<string, number> = {
    'Haus': 8, 'Hauskauf': 8,
    'Wohnung': 8, 'Wohnungskauf': 8,
    'Umschuldung': 7,
    'Grundstück': 6, 'Grundstueck': 6,
  };
  if (fa.finanzierungsart) {
    const key = Object.keys(finanzierungsartMap).find(k =>
      fa.finanzierungsart.toLowerCase().includes(k.toLowerCase())
    );
    rawScore += key ? finanzierungsartMap[key] : 6;
  }

  // 2. Immobilie bereits gefunden? (max 20 Pkt, korrigiert von 12)
  if (fa.immobilieGefunden) {
    const val = fa.immobilieGefunden.toLowerCase();
    if (val.includes('ja') || val === 'yes') rawScore += 20;
    else rawScore += 4;
  }

  // 3. Finanzieller Rahmen / Kaufpreis (max 15 Pkt)
  if (fa.kaufpreis) {
    const kp = fa.kaufpreis.replace(/[^0-9.]/g, '');
    const num = parseFloat(kp);
    if (!isNaN(num)) {
      if (num > 500000) rawScore += 15;
      else if (num > 300000) rawScore += 15;
      else if (num > 150000) rawScore += 12;
      else rawScore += 8;
    } else {
      // Text-basierte Zuordnung
      const text = fa.kaufpreis.toLowerCase();
      if (text.includes('500') || text.includes('über 500')) rawScore += 15;
      else if (text.includes('300')) rawScore += 15;
      else if (text.includes('150')) rawScore += 12;
      else rawScore += 8;
    }
  }

  // 4. Eigenmittel (max 40 Pkt, korrigiert von 25 — WICHTIGSTE FRAGE)
  if (fa.eigenmittel) {
    const em = fa.eigenmittel.replace(/[^0-9.]/g, '');
    const num = parseFloat(em);
    if (!isNaN(num)) {
      if (num > 50000) rawScore += 40;
      else if (num > 30000) rawScore += 35;
      else if (num > 10000) rawScore += 20;
      else rawScore += 5;
    } else {
      const text = fa.eigenmittel.toLowerCase();
      if (text.includes('50') || text.includes('über 50')) rawScore += 40;
      else if (text.includes('30')) rawScore += 35;
      else if (text.includes('10')) rawScore += 20;
      else rawScore += 5;
    }
  }

  // 5. Netto-Haushaltseinkommen (max 20 Pkt)
  if (fa.einkommen) {
    const ek = fa.einkommen.replace(/[^0-9.]/g, '');
    const num = parseFloat(ek);
    if (!isNaN(num)) {
      if (num > 6000) rawScore += 20;
      else if (num > 4000) rawScore += 18;
      else if (num > 2500) rawScore += 13;
      else rawScore += 6;
    } else {
      const text = fa.einkommen.toLowerCase();
      if (text.includes('6') || text.includes('über 6')) rawScore += 20;
      else if (text.includes('4')) rawScore += 18;
      else if (text.includes('2.5') || text.includes('2500')) rawScore += 13;
      else rawScore += 6;
    }
  }

  // 6. Berufliche Situation (max 20 Pkt)
  if (fa.beruf) {
    const berufMap: Record<string, number> = {
      'angestellt': 20,
      'selbstständig': 14, 'selbständig': 14, 'selbststaendig': 14, 'freelancer': 14,
      'pensionist': 10, 'pension': 10, 'rentner': 10,
      'arbeitslos': 3,
    };
    const berufLower = fa.beruf.toLowerCase();
    const key = Object.keys(berufMap).find(k => berufLower.includes(k));
    rawScore += key ? berufMap[key] : 10;
  }

  // Normalisieren auf 100 (max Rohpunkte = 8+20+15+40+20+20 = 123)
  const MAX_RAW = 123;
  const score = Math.round(Math.min(100, (rawScore / MAX_RAW) * 100));

  // Temperatur & Ampel basierend auf normalisiertem Score
  let temperatur: Temperatur;
  let ampelStatus: AmpelStatus;
  if (score >= 70) {
    temperatur = Temperatur.HOT;
    ampelStatus = AmpelStatus.GREEN;
  } else if (score >= 40) {
    temperatur = Temperatur.WARM;
    ampelStatus = AmpelStatus.YELLOW;
  } else {
    temperatur = Temperatur.COLD;
    ampelStatus = AmpelStatus.RED;
  }

  return { score, temperatur, ampelStatus };
}

export class LeadsController {
  // GET /api/leads
  async getAll(req: Request, res: Response) {
    try {
      const leads = await leadsService.getAll();
      res.json(leads);
    } catch (error: any) {
      console.error('LeadsController.getAll error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // GET /api/leads/:id
  async getById(req: Request, res: Response) {
    try {
      const lead = await leadsService.getById(req.params.id);
      res.json(lead);
    } catch (error: any) {
      console.error('LeadsController.getById error:', error);
      if (error.message === 'Lead not found') {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  }

  // POST /api/leads
  async create(req: Request, res: Response) {
    try {
      const lead = await leadsService.create(req.body);
      res.status(201).json(lead);
    } catch (error: any) {
      console.error('LeadsController.create error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // PATCH /api/leads/:id
  async update(req: any, res: Response) {
    try {
      const { assignSelf, ...updateData } = req.body;

      // Handle "Lead übernehmen" — assign to authenticated user
      if (assignSelf && req.user) {
        updateData.assignedToId = req.user.id;
        updateData.assignedAt = new Date();
      }

      const lead = await leadsService.update(req.params.id, updateData);
      res.json(lead);
    } catch (error: any) {
      console.error('LeadsController.update error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // DELETE /api/leads/:id
  async delete(req: Request, res: Response) {
    try {
      const result = await leadsService.delete(req.params.id);
      res.json(result);
    } catch (error: any) {
      console.error('LeadsController.delete error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // POST /api/leads/:id/convert-to-eigenkunde
  async convertToEigenkunde(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const userId = (req as AuthRequest).user?.id;
      const userName = (req as AuthRequest).user?.name || 'Unbekannt';

      if (!userId) {
        return res.status(401).json({ error: 'Nicht authentifiziert' });
      }

      // Lead prüfen
      const lead = await prisma.lead.findUnique({ where: { id } });
      if (!lead) {
        return res.status(404).json({ error: 'Lead nicht gefunden' });
      }
      if (lead.isKunde) {
        return res.status(400).json({ error: 'Lead ist bereits ein Eigenkunde' });
      }

      // Konvertieren
      const updated = await prisma.lead.update({
        where: { id },
        data: {
          isKunde: true,
          assignedToId: userId,
          assignedAt: new Date(),
        },
      });

      // Activity-Log
      await prisma.activity.create({
        data: {
          leadId: id,
          type: 'DEAL_UPDATED',
          title: 'Als Eigenkunde übernommen',
          description: `${userName} hat den Lead als Eigenkunden übernommen`,
        },
      });

      console.log(`[Leads] ✅ ${lead.firstName} ${lead.lastName} → Eigenkunde von ${userName}`);
      res.json(updated);
    } catch (error: any) {
      console.error('[Leads] convertToEigenkunde error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ============================================================
  // POST /api/leads/:id/archive — Kunde archivieren
  // ============================================================
  async archive(req: any, res: Response) {
    try {
      const { id } = req.params;
      const lead = await prisma.lead.findUnique({ where: { id } });
      if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });

      await prisma.lead.update({
        where: { id },
        data: { archivedAt: new Date() },
      });

      await prisma.activity.create({
        data: {
          leadId: id,
          type: 'DEAL_UPDATED',
          title: 'Kunde archiviert',
          description: `${req.user?.name || 'System'} hat den Kunden archiviert`,
        },
      });

      res.json({ success: true });
    } catch (error: any) {
      console.error('[Leads] archive error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ============================================================
  // POST /api/leads/:id/unarchive — Kunde wiederherstellen
  // ============================================================
  async unarchive(req: any, res: Response) {
    try {
      const { id } = req.params;
      await prisma.lead.update({
        where: { id },
        data: { archivedAt: null },
      });

      await prisma.activity.create({
        data: {
          leadId: id,
          type: 'DEAL_UPDATED',
          title: 'Kunde wiederhergestellt',
          description: `${req.user?.name || 'System'} hat den Kunden aus dem Archiv wiederhergestellt`,
        },
      });

      res.json({ success: true });
    } catch (error: any) {
      console.error('[Leads] unarchive error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ============================================================
  // POST /api/leads/:id/abschluss — Soft-Delete (Abschluss)
  // ============================================================
  async abschluss(req: any, res: Response) {
    try {
      const { id } = req.params;
      await prisma.lead.update({
        where: { id },
        data: { deletedAt: new Date() },
      });

      await prisma.activity.create({
        data: {
          leadId: id,
          type: 'DEAL_UPDATED',
          title: 'Kunde abgeschlossen',
          description: `${req.user?.name || 'System'} hat den Kunden endgültig abgeschlossen`,
        },
      });

      res.json({ success: true });
    } catch (error: any) {
      console.error('[Leads] abschluss error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ============================================================
  // POST /api/leads/onepage-funnel
  // Webhook from the OnePage embedded funnel
  // Creates lead with score + temperature from funnel answers,
  // syncs to Pipedrive, creates Google Drive folder
  // ============================================================
  async onepageFunnel(req: Request, res: Response) {
    try {
      console.log('[OnePage-Funnel] Received lead');

      const {
        firstName,
        lastName,
        email,
        phone,
        message,
        source,
        amount,
        score,
        temperatur,
        funnelAnswers,
      } = req.body;

      // Validate required fields
      if (!lastName || !email) {
        return res.status(400).json({
          error: 'Pflichtfelder fehlen: lastName, email',
        });
      }

      // Server-seitige Scoring-Berechnung aus funnelAnswers
      const scoring = calculateScoreFromFunnelAnswers(funnelAnswers);
      console.log(`[OnePage-Funnel] Scoring: ${scoring.score}/100 (${scoring.temperatur}, ${scoring.ampelStatus})`);

      // Check for duplicate lead by email
      const existingLead = await prisma.lead.findFirst({
        where: { email: email.toLowerCase().trim() },
      });

      if (existingLead) {
        console.log(`[OnePage-Funnel] Lead already exists: ${email} — updating score`);

        const updatedLead = await prisma.lead.update({
          where: { id: existingLead.id },
          data: {
            score: scoring.score,
            temperatur: scoring.temperatur,
            ampelStatus: scoring.ampelStatus,
            amount: amount || existingLead.amount,
            message: message || existingLead.message,
          },
        });

        await prisma.activity.create({
          data: {
            leadId: existingLead.id,
            type: 'DEAL_UPDATED',
            title: 'Funnel erneut ausgefüllt',
            description: `Neuer Score: ${scoring.score}/100 (${scoring.temperatur})`,
            data: { funnelAnswers } as any,
          },
        });

        return res.json({
          success: true,
          lead: updatedLead,
          isExisting: true,
        });
      }

      // Create new lead
      const lead = await prisma.lead.create({
        data: {
          firstName: (firstName || 'Nicht angegeben').trim(),
          lastName: lastName.trim(),
          email: email.toLowerCase().trim(),
          phone: (phone || '').trim(),
          source: source || 'ONEPAGE_FUNNEL',
          amount: amount || null,
          message: message || null,
          score: scoring.score,
          temperatur: scoring.temperatur,
          ampelStatus: scoring.ampelStatus,
          kaufwahrscheinlichkeit: scoring.score,
        },
      });

      console.log(`[OnePage-Funnel] ✅ Lead created: ${lead.firstName} ${lead.lastName} (Score: ${scoring.score}, ${scoring.temperatur})`);

      // Activity: Lead created
      await prisma.activity.create({
        data: {
          leadId: lead.id,
          type: 'LEAD_CREATED',
          title: 'Lead über Webseite erstellt',
          description: `Finanzierungsanfrage über OnePage-Funnel (Score: ${scoring.score}/100, ${scoring.temperatur})`,
          data: { funnelAnswers } as any,
        },
      });

      // Activity: Funnel details
      if (funnelAnswers) {
        const funnelSummary = [
          funnelAnswers.finanzierungsart && `Typ: ${funnelAnswers.finanzierungsart}`,
          funnelAnswers.immobilieGefunden && `Immobilie: ${funnelAnswers.immobilieGefunden}`,
          funnelAnswers.kaufpreis && `Rahmen: ${funnelAnswers.kaufpreis}`,
          funnelAnswers.eigenmittel && `Eigenmittel: ${funnelAnswers.eigenmittel}`,
          funnelAnswers.einkommen && `Einkommen: ${funnelAnswers.einkommen}`,
          funnelAnswers.beruf && `Beruf: ${funnelAnswers.beruf}`,
          funnelAnswers.plz && `PLZ: ${funnelAnswers.plz}`,
          funnelAnswers.sprache && `Sprache: ${funnelAnswers.sprache}`,
        ].filter(Boolean).join(' | ');

        await prisma.activity.create({
          data: {
            leadId: lead.id,
            type: 'NOTE_ADDED',
            title: 'Funnel-Antworten',
            description: funnelSummary,
          },
        });
      }

      // Google Drive folder (async, don't block response)
      createCustomerFolder(lead.firstName, lead.lastName)
        .then(async ({ folderId, folderUrl }) => {
          await prisma.lead.update({
            where: { id: lead.id },
            data: { googleDriveFolderId: folderId, googleDriveFolderUrl: folderUrl },
          });
          console.log(`[OnePage-Funnel] ✅ Drive folder: ${folderUrl}`);
        })
        .catch((err) => {
          console.error(`[OnePage-Funnel] ⚠️ Drive folder failed: ${err.message}`);
        });

      // Pipedrive sync (async, don't block response)
      syncFunnelLeadToPipedrive(lead.id).catch((err) => {
        console.error(`[OnePage-Funnel] Pipedrive sync failed: ${err.message}`);
      });

      res.status(201).json({
        success: true,
        lead: {
          id: lead.id,
          name: `${lead.firstName} ${lead.lastName}`,
          score: scoring.score,
          temperatur: scoring.temperatur,
        },
      });
    } catch (err: any) {
      console.error('[OnePage-Funnel] Error:', err);
      res.status(500).json({ error: err.message });
    }
  }
}

// ============================================================
// Helper: Sync funnel lead to Pipedrive
// ============================================================
async function syncFunnelLeadToPipedrive(leadId: string) {
  try {
    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) return;

    if (lead.pipedrivePersonId && lead.pipedriveDealId) {
      console.log('[OnePage-Funnel] Already synced to Pipedrive');
      return;
    }

    const fullName = `${lead.firstName} ${lead.lastName}`;
    const pipedriveData = await pipedriveService.createLead({
      name: fullName,
      email: lead.email,
      phone: lead.phone,
      source: lead.source,
      value: lead.amount || 0,
    });

    await prisma.lead.update({
      where: { id: leadId },
      data: {
        pipedrivePersonId: pipedriveData.person.id,
        pipedriveDealId: pipedriveData.deal.id,
      },
    });

    await prisma.deal.create({
      data: {
        leadId,
        pipedriveDealId: pipedriveData.deal.id,
        title: pipedriveData.deal.title,
        value: pipedriveData.deal.value,
        stage: 'NEUER_LEAD',
      },
    });

    await prisma.activity.create({
      data: {
        leadId,
        type: 'DEAL_CREATED',
        title: 'In Pipedrive erstellt',
        description: 'Person und Deal wurden in Pipedrive CRM angelegt (via Funnel)',
      },
    });

    console.log(`[OnePage-Funnel] ✅ Synced to Pipedrive: ${fullName}`);
  } catch (err: any) {
    console.error(`[OnePage-Funnel] Pipedrive error: ${err.message}`);
  }
}

export const leadsController = new LeadsController();