// src/controllers/deals.controller.ts
import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class DealsController {
  // GET /api/deals
  async getAll(req: Request, res: Response) {
    try {
      const deals = await prisma.deal.findMany({
        include: {
          lead: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });
      res.json(deals);
    } catch (error: any) {
      console.error('DealsController.getAll error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // GET /api/deals/:id
  async getById(req: Request, res: Response) {
    try {
      const deal = await prisma.deal.findUnique({
        where: { id: req.params.id },
        include: {
          lead: {
            include: {
              documents: true,
              activities: {
                orderBy: { createdAt: 'desc' },
                take: 10,
              },
            },
          },
        },
      });

      if (!deal) {
        return res.status(404).json({ error: 'Deal not found' });
      }

      res.json(deal);
    } catch (error: any) {
      console.error('DealsController.getById error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // PATCH /api/deals/:id/stage
  async updateStage(req: Request, res: Response) {
    try {
      const { stage } = req.body;

      const deal = await prisma.deal.update({
        where: { id: req.params.id },
        data: { stage },
        include: {
          lead: true,
        },
      });

      // Create activity
      await prisma.activity.create({
        data: {
          leadId: deal.leadId,
          type: 'DEAL_MOVED',
          title: 'Deal verschoben',
          description: `Deal wurde zu "${stage}" verschoben`,
        },
      });

      res.json(deal);
    } catch (error: any) {
      console.error('DealsController.updateStage error:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

export const dealsController = new DealsController();
