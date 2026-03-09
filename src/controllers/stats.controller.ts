// src/controllers/stats.controller.ts
import { Request, Response } from 'express';
import { leadsService } from '../services/leads.service';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth.middleware';

const prisma = new PrismaClient();

const PIPEDRIVE_API_TOKEN = process.env.PIPEDRIVE_API_TOKEN || '';
const PIPEDRIVE_BASE_URL = process.env.PIPEDRIVE_BASE_URL || 'https://api.pipedrive.com/v1';

export class StatsController {
  // GET /api/stats
  async getStats(req: Request, res: Response) {
    try {
      const stats = await leadsService.getStats();

      // Get today's activities count
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const [automationsToday, totalDocuments, documentsToday] = await Promise.all([
        prisma.activity.count({
          where: { createdAt: { gte: today } },
        }),
        prisma.document.count(),
        prisma.document.count({
          where: { uploadedAt: { gte: today } },
        }),
      ]);

      // Pipedrive active deals
      let activeDeals = stats.activeDeals || 0;
      let pipedriveVolume = 0;
      if (PIPEDRIVE_API_TOKEN) {
        try {
          const url = `${PIPEDRIVE_BASE_URL}/deals?status=open&limit=500&api_token=${PIPEDRIVE_API_TOKEN}`;
          const response = await fetch(url);
          const data = await response.json() as any;
          if (data.success && data.data) {
            activeDeals = data.data.length;
            pipedriveVolume = data.data.reduce((sum: number, d: any) => sum + (d.value || 0), 0);
          }
        } catch (err: any) {
          console.error('[Stats] Pipedrive error:', err.message);
        }
      }

      res.json({
        ...stats,
        activeDeals,
        pipedriveVolume,
        automationsToday,
        totalDocuments,
        documentsToday,
      });
    } catch (error: any) {
      console.error('StatsController.getStats error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // GET /api/stats/my-dashboard - Personalisiertes Dashboard
  async getMyDashboard(req: Request, res: Response) {
    try {
      const userId = (req as AuthRequest).user?.id;
      const userName = (req as AuthRequest).user?.name || 'Benutzer';
      if (!userId) return res.status(401).json({ error: 'Nicht authentifiziert' });

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const [
        meineKundenRaw,
        verfuegbareLeadsCount,
        neueLeadsHeute,
        letzteLeads,
        meineAktivitaeten,
        aktivitaetenHeute,
      ] = await Promise.all([
        // 1) Alle eigenen Kunden mit Completion-Info
        prisma.lead.findMany({
          where: { isKunde: true, assignedToId: userId },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            ampelStatus: true,
            temperatur: true,
            person: { select: { id: true } },
            haushalt: { select: { id: true } },
            finanzplan: { select: { id: true } },
            objekte: { select: { id: true } },
          },
          orderBy: { createdAt: 'desc' },
        }),

        // 2) Verfügbare Leads (nicht konvertiert)
        prisma.lead.count({ where: { isKunde: false } }),

        // 3) Neue Leads heute
        prisma.lead.count({ where: { isKunde: false, createdAt: { gte: today } } }),

        // 4) Letzte 5 Leads für Preview
        prisma.lead.findMany({
          where: { isKunde: false },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            source: true,
            temperatur: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
        }),

        // 5) Letzte 10 Activities auf MEINEN Kunden
        prisma.activity.findMany({
          where: {
            lead: { isKunde: true, assignedToId: userId },
          },
          include: {
            lead: { select: { id: true, firstName: true, lastName: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),

        // 6) Aktivitäten heute auf meinen Kunden
        prisma.activity.count({
          where: {
            createdAt: { gte: today },
            lead: { isKunde: true, assignedToId: userId },
          },
        }),
      ]);

      // Completion & Verteilung berechnen
      let ampelGreen = 0, ampelYellow = 0, ampelRed = 0;
      let tempHot = 0, tempWarm = 0, tempCold = 0;

      const offeneKunden = meineKundenRaw
        .map((k) => {
          if (k.ampelStatus === 'GREEN') ampelGreen++;
          else if (k.ampelStatus === 'YELLOW') ampelYellow++;
          else ampelRed++;

          if (k.temperatur === 'HOT') tempHot++;
          else if (k.temperatur === 'WARM') tempWarm++;
          else tempCold++;

          const hasPersonData = !!k.person;
          const hasHaushaltData = !!k.haushalt;
          const hasFinanzplanData = !!k.finanzplan;
          const objekteCount = k.objekte.length;

          let missingCount = 0;
          if (!hasPersonData) missingCount++;
          if (!hasHaushaltData) missingCount++;
          if (!hasFinanzplanData) missingCount++;
          if (objekteCount === 0) missingCount++;

          return {
            id: k.id,
            firstName: k.firstName,
            lastName: k.lastName,
            ampelStatus: k.ampelStatus,
            temperatur: k.temperatur,
            hasPersonData,
            hasHaushaltData,
            hasFinanzplanData,
            objekteCount,
            missingCount,
          };
        })
        .filter((k) => k.missingCount > 0)
        .sort((a, b) => b.missingCount - a.missingCount);

      res.json({
        userName,
        meineKunden: {
          total: meineKundenRaw.length,
          mitOffenenDaten: offeneKunden.length,
          ampelVerteilung: { green: ampelGreen, yellow: ampelYellow, red: ampelRed },
          temperaturVerteilung: { hot: tempHot, warm: tempWarm, cold: tempCold },
        },
        verfuegbareLeads: {
          total: verfuegbareLeadsCount,
          neueHeute: neueLeadsHeute,
          letzteLeads,
        },
        offeneKunden,
        meineAktivitaeten,
        aktivitaetenHeute,
      });
    } catch (error: any) {
      console.error('StatsController.getMyDashboard error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // GET /api/stats/activities - Recent activities
  async getActivities(req: Request, res: Response) {
    try {
      const activities = await prisma.activity.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: {
          lead: {
            select: {
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
      });

      res.json(activities);
    } catch (error: any) {
      console.error('StatsController.getActivities error:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

export const statsController = new StatsController();