// src/services/leads.service.ts
import { PrismaClient, AmpelStatus, Temperatur } from '@prisma/client';
import { pipedriveService } from '../integrations/pipedrive.service';
import { createCustomerFolder } from './googleDrive.service';

const prisma = new PrismaClient();

export interface CreateLeadDto {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  source: string;
  amount?: number;
  message?: string;
}

export interface UpdateLeadDto {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  source?: string;
  amount?: number;
  message?: string;
  ampelStatus?: AmpelStatus;
  temperatur?: Temperatur;
  score?: number;
  kaufwahrscheinlichkeit?: number;
}

export class LeadsService {
  // Get all leads (nur nicht-konvertierte — Eigenkunden sind im /kunde Bereich)
  async getAll(filters?: any) {
    return await prisma.lead.findMany({
      where: {
        ...filters,
        isKunde: false,
      },
      include: {
        deal: true,
        documents: true,
        activities: {
          take: 5,
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  // Get lead by ID
  async getById(id: string) {
    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        deal: true,
        documents: true,
        activities: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!lead) {
      throw new Error('Lead not found');
    }

    return lead;
  }

  // Create lead
  async create(data: CreateLeadDto) {
    try {
      // 1. Create lead in database
      const lead = await prisma.lead.create({
        data: {
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email,
          phone: data.phone,
          source: data.source,
          amount: data.amount,
          message: data.message,
          ampelStatus: AmpelStatus.YELLOW,
          temperatur: Temperatur.WARM,
          score: 0,
        },
      });

      // 2. Create activity
      await prisma.activity.create({
        data: {
          leadId: lead.id,
          type: 'LEAD_CREATED',
          title: 'Lead erstellt',
          description: `Lead wurde erstellt über ${data.source}`,
        },
      });

      // 2.5 Google Drive Ordner erstellen (async, don't block)
      createCustomerFolder(data.firstName, data.lastName)
        .then(async ({ folderId, folderUrl }) => {
          await prisma.lead.update({
            where: { id: lead.id },
            data: { googleDriveFolderId: folderId, googleDriveFolderUrl: folderUrl },
          });
          console.log(`[Leads] ✅ Google Drive Ordner: ${folderUrl}`);
        })
        .catch((err) => {
          console.error(`[Leads] ⚠️ Google Drive Ordner fehlgeschlagen:`, err.message);
        });

      // 3. Sync to Pipedrive (async, don't block)
      this.syncToPipedrive(lead.id).catch((error) => {
        console.error('Failed to sync lead to Pipedrive:', error.message);
      });

      return lead;
    } catch (error: any) {
      console.error('LeadsService.create error:', error);
      throw new Error(`Failed to create lead: ${error.message}`);
    }
  }

  // Update lead
  async update(id: string, data: UpdateLeadDto) {
    try {
      const lead = await prisma.lead.update({
        where: { id },
        data,
        include: {
          deal: true,
        },
      });

      await prisma.activity.create({
        data: {
          leadId: lead.id,
          type: 'DEAL_UPDATED',
          title: 'Lead aktualisiert',
          description: 'Lead-Daten wurden geändert',
        },
      });

      if (lead.pipedrivePersonId) {
        this.updateInPipedrive(lead.id).catch((error) => {
          console.error('Failed to update lead in Pipedrive:', error.message);
        });
      }

      return lead;
    } catch (error: any) {
      console.error('LeadsService.update error:', error);
      throw new Error(`Failed to update lead: ${error.message}`);
    }
  }

  // Delete lead
  async delete(id: string) {
    try {
      const lead = await prisma.lead.findUnique({
        where: { id },
      });

      if (!lead) {
        throw new Error('Lead not found');
      }

      if (lead.pipedriveDealId) {
        try {
          await pipedriveService.deleteDeal(lead.pipedriveDealId);
        } catch (error: any) {
          console.error('Failed to delete deal from Pipedrive:', error.message);
        }
      }

      if (lead.pipedrivePersonId) {
        try {
          await pipedriveService.deletePerson(lead.pipedrivePersonId);
        } catch (error: any) {
          console.error('Failed to delete person from Pipedrive:', error.message);
        }
      }

      await prisma.lead.delete({
        where: { id },
      });

      return { success: true, message: 'Lead deleted successfully' };
    } catch (error: any) {
      console.error('LeadsService.delete error:', error);
      throw new Error(`Failed to delete lead: ${error.message}`);
    }
  }

  // Sync lead to Pipedrive
  private async syncToPipedrive(leadId: string) {
    try {
      const lead = await prisma.lead.findUnique({
        where: { id: leadId },
      });

      if (!lead) {
        throw new Error('Lead not found');
      }

      if (lead.pipedrivePersonId && lead.pipedriveDealId) {
        console.log('Lead already synced to Pipedrive');
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
          leadId: leadId,
          pipedriveDealId: pipedriveData.deal.id,
          title: pipedriveData.deal.title,
          value: pipedriveData.deal.value,
          stage: 'NEUER_LEAD',
        },
      });

      await prisma.activity.create({
        data: {
          leadId: leadId,
          type: 'DEAL_CREATED',
          title: 'In Pipedrive erstellt',
          description: `Person und Deal wurden in Pipedrive CRM angelegt`,
        },
      });

      console.log(`Lead ${leadId} successfully synced to Pipedrive`);
    } catch (error: any) {
      console.error('syncToPipedrive error:', error);
      throw error;
    }
  }

  // Update lead in Pipedrive
  private async updateInPipedrive(leadId: string) {
    try {
      const lead = await prisma.lead.findUnique({
        where: { id: leadId },
      });

      if (!lead || !lead.pipedrivePersonId) {
        return;
      }

      const fullName = `${lead.firstName} ${lead.lastName}`;

      await pipedriveService.updatePerson(lead.pipedrivePersonId, {
        name: fullName,
        email: lead.email,
        phone: lead.phone,
      });

      console.log(`Lead ${leadId} updated in Pipedrive`);
    } catch (error: any) {
      console.error('updateInPipedrive error:', error);
      throw error;
    }
  }

  // Get stats
  async getStats() {
    const [total, greenLeads, yellowLeads, redLeads] = await Promise.all([
      prisma.lead.count(),
      prisma.lead.count({ where: { ampelStatus: AmpelStatus.GREEN } }),
      prisma.lead.count({ where: { ampelStatus: AmpelStatus.YELLOW } }),
      prisma.lead.count({ where: { ampelStatus: AmpelStatus.RED } }),
    ]);

    const activeDeals = await prisma.deal.count({
      where: {
        stage: {
          notIn: ['ABGESCHLOSSEN', 'VERLOREN'],
        },
      },
    });

    return {
      totalLeads: total,
      greenLeads,
      yellowLeads,
      redLeads,
      activeDeals,
    };
  }
}

export const leadsService = new LeadsService();