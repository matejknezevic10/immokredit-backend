// src/controllers/leads.controller.ts
import { Request, Response } from 'express';
import { PrismaClient, AmpelStatus, Temperatur } from '@prisma/client';
import { leadsService } from '../services/leads.service';
import { createCustomerFolder } from '../services/googleDrive.service';
import { pipedriveService } from '../integrations/pipedrive.service';
import { AuthRequest } from '../middleware/auth.middleware';

const prisma = new PrismaClient();

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
  async update(req: Request, res: Response) {
    try {
      const lead = await leadsService.update(req.params.id, req.body);
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

      // Map temperatur string to Prisma enum
      const tempMap: Record<string, Temperatur> = {
        HOT: Temperatur.HOT,
        WARM: Temperatur.WARM,
        COLD: Temperatur.COLD,
      };

      // Map temperatur to ampel status
      const ampelMap: Record<string, AmpelStatus> = {
        HOT: AmpelStatus.GREEN,
        WARM: AmpelStatus.YELLOW,
        COLD: AmpelStatus.RED,
      };

      // Check for duplicate lead by email
      const existingLead = await prisma.lead.findFirst({
        where: { email: email.toLowerCase().trim() },
      });

      if (existingLead) {
        console.log(`[OnePage-Funnel] Lead already exists: ${email} — updating score`);

        const updatedLead = await prisma.lead.update({
          where: { id: existingLead.id },
          data: {
            score: score || existingLead.score,
            temperatur: tempMap[temperatur] || existingLead.temperatur,
            ampelStatus: ampelMap[temperatur] || existingLead.ampelStatus,
            amount: amount || existingLead.amount,
            message: message || existingLead.message,
          },
        });

        await prisma.activity.create({
          data: {
            leadId: existingLead.id,
            type: 'DEAL_UPDATED',
            title: 'Funnel erneut ausgefüllt',
            description: `Neuer Score: ${score}/100 (${temperatur})`,
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
          score: score || 0,
          temperatur: tempMap[temperatur] || Temperatur.WARM,
          ampelStatus: ampelMap[temperatur] || AmpelStatus.YELLOW,
          kaufwahrscheinlichkeit: score || 0,
        },
      });

      console.log(`[OnePage-Funnel] ✅ Lead created: ${lead.firstName} ${lead.lastName} (Score: ${score}, ${temperatur})`);

      // Activity: Lead created
      await prisma.activity.create({
        data: {
          leadId: lead.id,
          type: 'LEAD_CREATED',
          title: 'Lead über Webseite erstellt',
          description: `Finanzierungsanfrage über OnePage-Funnel (Score: ${score}/100, ${temperatur})`,
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
          score,
          temperatur,
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