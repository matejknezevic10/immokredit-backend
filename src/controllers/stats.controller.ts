// src/controllers/stats.controller.ts
import { Request, Response } from 'express';
import { leadsService } from '../services/leads.service';
import { PrismaClient } from '@prisma/client';

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