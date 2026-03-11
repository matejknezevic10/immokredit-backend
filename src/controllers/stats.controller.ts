// src/controllers/stats.controller.ts
import { Request, Response } from 'express';
import { leadsService } from '../services/leads.service';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth.middleware';

const prisma = new PrismaClient();

const PIPEDRIVE_API_TOKEN = process.env.PIPEDRIVE_API_TOKEN || '';
const PIPEDRIVE_BASE_URL = process.env.PIPEDRIVE_BASE_URL || 'https://api.pipedrive.com/v1';
const ZUSTAENDIG_FIELD_KEY = process.env.PIPEDRIVE_ZUSTAENDIG_FIELD_KEY || '';

// Pipedrive Team-Mapping (gleich wie in pipedrive.routes.ts)
const TEAM_MEMBERS = [
  { id: 38, name: 'Roland', fullName: 'Roland Potlog', email: 'roland@immo-kredit.net' },
  { id: 39, name: 'Slaven', fullName: 'Slaven Pavic', email: 'slaven@immo-kredit.net' },
  { id: 40, name: 'Daniel', fullName: 'Daniel Tunjic', email: 'daniel@immo-kredit.net' },
];

function resolveAssignee(deal: any): { id: number; name: string; fullName: string } | null {
  if (!ZUSTAENDIG_FIELD_KEY) return null;
  const fieldValue = deal[ZUSTAENDIG_FIELD_KEY];
  if (!fieldValue) return null;
  const optionId = typeof fieldValue === 'string' ? parseInt(fieldValue) : fieldValue;
  return TEAM_MEMBERS.find((m) => m.id === optionId) || null;
}

// Pipedrive Stage-Namen → kurze Labels
function mapStageName(stageName: string): string {
  const name = stageName.toLowerCase();
  if (name.includes('sammeln') || name.includes('unterlagen s')) return 'Unterlagen sammeln';
  if (name.includes('vollständig') || name.includes('vollstaendig') || name.includes('aufbereitung')) return 'Aufbereitung';
  if (name.includes('bank') || name.includes('eingereicht')) return 'Eingereicht / Bank';
  if (name.includes('genehmigt') || name.includes('angebot') || name.includes('zusage')) return 'Genehmigt';
  if (name.includes('abschluss') || name.includes('won') || name.includes('gewonnen')) return 'Abschluss';
  if (name.includes('neuer') || name.includes('lead')) return 'Neuer Lead';
  if (name.includes('qualif')) return 'Qualifiziert';
  return stageName;
}

// Stages-Cache für Pipedrive
let stagesCache: any[] | null = null;
let stagesCacheTime = 0;

async function getStages(): Promise<any[]> {
  if (stagesCache && Date.now() - stagesCacheTime < 5 * 60 * 1000) {
    return stagesCache;
  }
  try {
    const pipRes = await fetch(`${PIPEDRIVE_BASE_URL}/pipelines?api_token=${PIPEDRIVE_API_TOKEN}`);
    const pipData = await pipRes.json() as any;
    if (!pipData.success || !pipData.data?.length) return [];
    const stgRes = await fetch(`${PIPEDRIVE_BASE_URL}/stages?pipeline_id=${pipData.data[0].id}&api_token=${PIPEDRIVE_API_TOKEN}`);
    const stgData = await stgRes.json() as any;
    stagesCache = stgData.data || [];
    stagesCacheTime = Date.now();
    return stagesCache!;
  } catch {
    return [];
  }
}

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
        // 1) Alle eigenen Kunden mit Completion-Info (ohne archivierte/gelöschte)
        prisma.lead.findMany({
          where: { isKunde: true, assignedToId: userId, archivedAt: null, deletedAt: null },
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

      const alleKunden = meineKundenRaw
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
        .sort((a, b) => b.missingCount - a.missingCount);

      // Backward compat: offeneKunden = nur die mit fehlenden Daten
      const offeneKunden = alleKunden.filter((k) => k.missingCount > 0);

      // Top Leads nach Score (alle Leads, nicht nur eigene Kunden)
      const topLeads = await prisma.lead.findMany({
        where: { isKunde: false, score: { gt: 0 } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          score: true,
          ampelStatus: true,
          temperatur: true,
          source: true,
          amount: true,
          createdAt: true,
        },
        orderBy: { score: 'desc' },
        take: 5,
      });

      // Lead-Qualität: Verteilung über ALLE Leads (nicht nur Kunden)
      const allLeads = await prisma.lead.findMany({
        where: { isKunde: false },
        select: { score: true, ampelStatus: true, temperatur: true },
      });
      const leadQualitaet = {
        total: allLeads.length,
        avgScore: allLeads.length > 0 ? Math.round(allLeads.reduce((sum, l) => sum + l.score, 0) / allLeads.length) : 0,
        ampel: {
          green: allLeads.filter(l => l.ampelStatus === 'GREEN').length,
          yellow: allLeads.filter(l => l.ampelStatus === 'YELLOW').length,
          red: allLeads.filter(l => l.ampelStatus === 'RED').length,
        },
        temperatur: {
          hot: allLeads.filter(l => l.temperatur === 'HOT').length,
          warm: allLeads.filter(l => l.temperatur === 'WARM').length,
          cold: allLeads.filter(l => l.temperatur === 'COLD').length,
        },
      };

      // Pipedrive Deals für diesen User laden
      let meineDeals: any[] = [];
      if (PIPEDRIVE_API_TOKEN) {
        try {
          const stages = await getStages();
          const stageMap = new Map(stages.map((s: any) => [s.id, s]));

          // User-Name → Pipedrive Member matchen (Vorname reicht)
          const userFirstName = userName.split(' ')[0].toLowerCase();

          const dealsRes = await fetch(`${PIPEDRIVE_BASE_URL}/deals?status=open&limit=500&api_token=${PIPEDRIVE_API_TOKEN}`);
          const dealsData = await dealsRes.json() as any;
          if (dealsData.success && dealsData.data) {
            meineDeals = dealsData.data
              .map((d: any) => {
                const assignee = resolveAssignee(d);
                const stage = stageMap.get(d.stage_id);
                return {
                  pipedriveDealId: d.id,
                  title: d.title,
                  value: d.value || 0,
                  stage: stage?.name ? mapStageName(stage.name) : 'Unbekannt',
                  personName: d.person_id?.name || null,
                  assigneeName: assignee?.name || null,
                  addTime: d.add_time,
                };
              })
              .filter((d: any) =>
                d.assigneeName && d.assigneeName.toLowerCase() === userFirstName
              );
          }
        } catch (err: any) {
          console.error('[Dashboard] Pipedrive deals error:', err.message);
        }
      }

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
        alleKunden,
        meineAktivitaeten,
        aktivitaetenHeute,
        meineDeals,
        topLeads,
        leadQualitaet,
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