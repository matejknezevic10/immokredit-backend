// src/routes/pipedrive.routes.ts
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createSecureDocumentLink } from '../services/secureLink.service';

const router = Router();
const prisma = new PrismaClient();

const PIPEDRIVE_API_TOKEN = process.env.PIPEDRIVE_API_TOKEN || '';
const PIPEDRIVE_BASE_URL = process.env.PIPEDRIVE_BASE_URL || 'https://api.pipedrive.com/v1';

// Custom field for "Zuständig" - the field key from Pipedrive
const ZUSTAENDIG_FIELD_KEY = process.env.PIPEDRIVE_ZUSTAENDIG_FIELD_KEY || '';
const ZUSTAENDIG_FIELD_ID = parseInt(process.env.PIPEDRIVE_ZUSTAENDIG_FIELD_ID || '45');

// User mapping: app user email → Pipedrive option ID
const TEAM_MEMBERS = [
  { id: 38, name: 'Roland', fullName: 'Roland Potlog', email: 'roland@immo-kredit.net' },
  { id: 39, name: 'Slaven', fullName: 'Slaven Pavic', email: 'slaven@immo-kredit.net' },
  { id: 40, name: 'Daniel', fullName: 'Daniel Tunjic', email: 'daniel@immo-kredit.net' },
];

async function pipedriveRequest(endpoint: string): Promise<any> {
  const separator = endpoint.includes('?') ? '&' : '?';
  const url = `${PIPEDRIVE_BASE_URL}${endpoint}${separator}api_token=${PIPEDRIVE_API_TOKEN}`;
  const response = await fetch(url);
  const data = await response.json() as any;
  if (!data.success) throw new Error(data.error || 'Pipedrive API error');
  return data;
}

// Cache for stages
let stagesCache: any[] | null = null;
let stagesCacheTime = 0;

async function getStages(): Promise<any[]> {
  if (stagesCache && Date.now() - stagesCacheTime < 5 * 60 * 1000) {
    return stagesCache;
  }
  const pipelines = await pipedriveRequest('/pipelines');
  if (!pipelines.data?.length) return [];
  const stages = await pipedriveRequest(`/stages?pipeline_id=${pipelines.data[0].id}`);
  stagesCache = stages.data || [];
  stagesCacheTime = Date.now();
  return stagesCache!;
}

function mapStage(stageName: string, orderNr: number): string {
  const name = stageName.toLowerCase();
  if (name.includes('neuer') || name.includes('new') || name.includes('lead')) return 'NEUER_LEAD';
  if (name.includes('qualif')) return 'QUALIFIZIERT';
  if (name.includes('sammeln') || name.includes('unterlagen s')) return 'UNTERLAGEN_SAMMELN';
  if (name.includes('vollständig') || name.includes('vollstaendig') || name.includes('komplett')) return 'UNTERLAGEN_VOLLSTAENDIG';
  if (name.includes('bank') || name.includes('anfrage')) return 'BANK_ANFRAGE';
  if (name.includes('warten') || name.includes('zusage')) return 'WARTEN_AUF_ZUSAGE';
  if (name.includes('erhalten') || name.includes('zugesagt')) return 'ZUSAGE_ERHALTEN';
  if (name.includes('abgeschlossen') || name.includes('abschluss') || name.includes('won') || name.includes('gewonnen')) return 'ABGESCHLOSSEN';
  if (name.includes('verloren') || name.includes('lost')) return 'VERLOREN';
  const stageMap = ['NEUER_LEAD', 'QUALIFIZIERT', 'UNTERLAGEN_SAMMELN', 'UNTERLAGEN_VOLLSTAENDIG', 'BANK_ANFRAGE', 'WARTEN_AUF_ZUSAGE', 'ZUSAGE_ERHALTEN', 'ABGESCHLOSSEN', 'VERLOREN'];
  return stageMap[orderNr] || 'NEUER_LEAD';
}

// Resolve assignee from deal's custom field
function resolveAssignee(deal: any): { id: number; name: string; fullName: string } | null {
  if (!ZUSTAENDIG_FIELD_KEY) return null;
  const fieldValue = deal[ZUSTAENDIG_FIELD_KEY];
  if (!fieldValue) return null;

  // fieldValue is the option ID (number or string)
  const optionId = typeof fieldValue === 'string' ? parseInt(fieldValue) : fieldValue;
  return TEAM_MEMBERS.find((m) => m.id === optionId) || null;
}

// GET /api/pipedrive/team - Get team members
router.get('/team', (_req: Request, res: Response) => {
  res.json(TEAM_MEMBERS);
});

// GET /api/pipedrive/deals?assignee=roland
router.get('/deals', async (req: Request, res: Response) => {
  try {
    if (!PIPEDRIVE_API_TOKEN) {
      return res.status(500).json({ error: 'Pipedrive API token not configured' });
    }

    const assigneeFilter = (req.query.assignee as string || '').toLowerCase();

    const stages = await getStages();
    const stageMap = new Map(stages.map((s: any) => [s.id, s]));

    const dealsResponse = await pipedriveRequest('/deals?status=open&limit=500');
    const pipedriveDeals = dealsResponse.data || [];

    let deals = pipedriveDeals.map((d: any) => {
      const stage = stageMap.get(d.stage_id);
      const stageName = stage?.name || 'Unknown';
      const stageOrder = stage?.order_nr || 0;
      const assignee = resolveAssignee(d);

      return {
        id: `pd-${d.id}`,
        pipedriveDealId: d.id,
        title: d.title,
        value: d.value || 0,
        currency: d.currency || 'EUR',
        stage: mapStage(stageName, stageOrder),
        pipedriveStage: stageName,
        pipedriveStageId: d.stage_id,
        personName: d.person_id?.name || null,
        personEmail: d.person_id?.email?.[0]?.value || null,
        personPhone: d.person_id?.phone?.[0]?.value || null,
        orgName: d.org_id?.name || null,
        ownerName: d.owner_name || null,
        assignee: assignee ? { id: assignee.id, name: assignee.name, fullName: assignee.fullName } : null,
        addTime: d.add_time,
        updateTime: d.update_time,
        expectedCloseDate: d.expected_close_date,
        probability: d.probability,
        status: d.status,
        leadId: null,
        lead: d.person_id ? {
          firstName: d.person_id.name?.split(' ')[0] || '',
          lastName: d.person_id.name?.split(' ').slice(1).join(' ') || '',
          email: d.person_id.email?.[0]?.value || '',
          phone: d.person_id.phone?.[0]?.value || '',
          ampelStatus: 'YELLOW',
          temperatur: 'WARM',
          score: 0,
        } : null,
      };
    });

    // Enrich with local leadId from DB — try matching, then auto-create for unmatched
    const pipedriveDealIds = deals.map((d: any) => d.pipedriveDealId).filter(Boolean);
    if (pipedriveDealIds.length > 0) {
      const leadIdMap = new Map<number, string>();

      // Strategy 1: Match via Deal.pipedriveDealId → Deal.leadId
      const localDeals = await prisma.deal.findMany({
        where: { pipedriveDealId: { in: pipedriveDealIds } },
        select: { pipedriveDealId: true, leadId: true },
      });
      for (const d of localDeals) leadIdMap.set(d.pipedriveDealId, d.leadId);

      // Strategy 2: Match via Lead.pipedriveDealId → Lead.id
      const unmatchedIds1 = pipedriveDealIds.filter((id: number) => !leadIdMap.has(id));
      if (unmatchedIds1.length > 0) {
        const localLeads = await prisma.lead.findMany({
          where: { pipedriveDealId: { in: unmatchedIds1 } },
          select: { pipedriveDealId: true, id: true },
        });
        for (const lead of localLeads) {
          if (lead.pipedriveDealId) leadIdMap.set(lead.pipedriveDealId, lead.id);
        }
      }

      // Strategy 3: Match via person email → Lead.email
      const unmatchedDeals2 = deals.filter((d: any) => !leadIdMap.has(d.pipedriveDealId) && d.personEmail);
      if (unmatchedDeals2.length > 0) {
        const emails = unmatchedDeals2.map((d: any) => d.personEmail).filter(Boolean);
        const emailLeads = await prisma.lead.findMany({
          where: { email: { in: emails } },
          select: { email: true, id: true },
        });
        const emailMap = new Map(emailLeads.map(l => [l.email.toLowerCase(), l.id]));
        for (const deal of unmatchedDeals2) {
          const leadId = emailMap.get(deal.personEmail?.toLowerCase());
          if (leadId) leadIdMap.set(deal.pipedriveDealId, leadId);
        }
      }

      // Strategy 4: Auto-create local Lead+Deal for remaining unmatched Pipedrive deals
      const stillUnmatched = deals.filter((d: any) => !leadIdMap.has(d.pipedriveDealId) && d.personName);
      for (const deal of stillUnmatched) {
        try {
          const nameParts = (deal.personName || '').split(' ');
          const firstName = nameParts[0] || 'Unbekannt';
          const lastName = nameParts.slice(1).join(' ') || '';
          const stageFromPd = deal.stage || 'NEUER_LEAD';

          const newLead = await prisma.lead.create({
            data: {
              firstName,
              lastName,
              email: deal.personEmail || `pd-${deal.pipedriveDealId}@pipedrive.local`,
              phone: deal.personPhone || '',
              source: 'Pipedrive',
              amount: deal.value || 0,
              pipedriveDealId: deal.pipedriveDealId,
              ampelStatus: 'YELLOW',
              temperatur: 'WARM',
              score: 0,
              deal: {
                create: {
                  pipedriveDealId: deal.pipedriveDealId,
                  title: deal.title || `${firstName} ${lastName}`,
                  value: deal.value || 0,
                  stage: stageFromPd as any,
                },
              },
            },
          });
          leadIdMap.set(deal.pipedriveDealId, newLead.id);
          console.log(`[Pipedrive] Auto-created Lead+Deal for PD deal ${deal.pipedriveDealId} (${deal.personName})`);
        } catch (autoErr: any) {
          // Might fail if email already exists (unique constraint) — non-critical
          console.warn(`[Pipedrive] Auto-create failed for deal ${deal.pipedriveDealId}: ${autoErr.message}`);
        }
      }

      console.log(`[Pipedrive] Enrichment: ${pipedriveDealIds.length} pipeline deals → ${leadIdMap.size} matched/created`);
      deals = deals.map((d: any) => ({ ...d, leadId: leadIdMap.get(d.pipedriveDealId) || null }));
    }

    // Filter by assignee if requested
    if (assigneeFilter && assigneeFilter !== 'alle') {
      deals = deals.filter((d: any) => {
        if (!d.assignee) return false;
        return d.assignee.name.toLowerCase() === assigneeFilter;
      });
    }

    res.json(deals);
  } catch (err: any) {
    console.error('[Pipedrive] Error fetching deals:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pipedrive/stages
router.get('/stages', async (_req: Request, res: Response) => {
  try {
    const stages = await getStages();
    const mapped = stages.map((s: any) => ({
      id: s.id,
      name: s.name,
      orderNr: s.order_nr,
      localStage: mapStage(s.name, s.order_nr),
      dealsCount: s.deals_summary?.total_count || 0,
    }));
    res.json(mapped);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/pipedrive/deals/:id/stage
router.put('/deals/:id/stage', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { stageId } = req.body;
    if (!stageId) return res.status(400).json({ error: 'stageId is required' });

    const url = `${PIPEDRIVE_BASE_URL}/deals/${id}?api_token=${PIPEDRIVE_API_TOKEN}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage_id: stageId }),
    });
    const data = await response.json() as any;
    if (!data.success) throw new Error(data.error || 'Failed to update deal stage');

    // Sync local DB deal stage — try Deal first, then Lead fallback
    try {
      const stages = await getStages();
      const targetStage = stages.find((s: any) => s.id === stageId);
      if (targetStage) {
        const localStage = mapStage(targetStage.name, targetStage.order_nr);
        let localDeal = await prisma.deal.findUnique({
          where: { pipedriveDealId: parseInt(id) },
        });

        // Fallback: find via Lead.pipedriveDealId
        if (!localDeal) {
          const lead = await prisma.lead.findFirst({
            where: { pipedriveDealId: parseInt(id) },
            include: { deal: true },
          });
          if (lead?.deal) localDeal = lead.deal;
        }

        if (localDeal) {
          await prisma.deal.update({
            where: { id: localDeal.id },
            data: { stage: localStage as any },
          });
          console.log(`[Pipedrive] Synced local deal ${localDeal.id} to stage ${localStage}`);

          // Auto-trigger: Send secure document link when deal reaches ABGESCHLOSSEN
          if (localStage === 'ABGESCHLOSSEN') {
            createSecureDocumentLink({ leadId: localDeal.leadId }).then(result => {
              if (result.success) {
                console.log(`[Pipedrive] Auto-sent secure link for lead ${localDeal!.leadId}`);
              } else {
                console.warn(`[Pipedrive] Secure link failed: ${result.error}`);
              }
            }).catch(err => console.error('[Pipedrive] Secure link error:', err));
          }
        }
      }
    } catch (syncErr) {
      console.warn('[Pipedrive] Stage sync failed (non-critical):', syncErr);
    }

    res.json({ success: true, deal: data.data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/pipedrive/deals/:id/assign - Assign deal to team member
router.put('/deals/:id/assign', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { assigneeId } = req.body; // Option ID (38, 39, 40) or null to unassign

    if (!ZUSTAENDIG_FIELD_KEY) {
      return res.status(500).json({ error: 'Zuständig field not configured' });
    }

    const member = assigneeId ? TEAM_MEMBERS.find((m) => m.id === assigneeId) : null;

    const url = `${PIPEDRIVE_BASE_URL}/deals/${id}?api_token=${PIPEDRIVE_API_TOKEN}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [ZUSTAENDIG_FIELD_KEY]: assigneeId || null }),
    });
    const data = await response.json() as any;
    if (!data.success) throw new Error(data.error || 'Failed to assign deal');

    console.log(`[Pipedrive] Deal ${id} assigned to ${member?.fullName || 'niemand'}`);
    res.json({ success: true, assignee: member || null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pipedrive/activities
router.get('/activities', async (_req: Request, res: Response) => {
  try {
    const response = await pipedriveRequest('/activities?limit=20&done=0');
    const activities = (response.data || []).map((a: any) => ({
      id: a.id,
      type: a.type,
      subject: a.subject,
      note: a.note,
      dueDate: a.due_date,
      dealTitle: a.deal_title,
      personName: a.person_name,
      done: a.done,
    }));
    res.json(activities);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;