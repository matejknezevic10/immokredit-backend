// src/controllers/kunde.controller.ts
import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { berechneKennzahlen } from '../services/kennzahlen.service';

const prisma = new PrismaClient();

export const kundeController = {
  // ── Get all Kunden (leads with customer data) ──
  async getAll(req: Request, res: Response) {
    try {
      const kunden = await prisma.lead.findMany({
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          ampelStatus: true,
          temperatur: true,
          createdAt: true,
          person: { select: { id: true } },
          haushalt: { select: { id: true } },
          finanzplan: { select: { id: true } },
          objekte: { select: { id: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      const result = kunden.map(k => ({
        id: k.id,
        firstName: k.firstName,
        lastName: k.lastName,
        email: k.email,
        phone: k.phone,
        ampelStatus: k.ampelStatus,
        temperatur: k.temperatur,
        createdAt: k.createdAt,
        hasPersonData: !!k.person,
        hasHaushaltData: !!k.haushalt,
        hasFinanzplanData: !!k.finanzplan,
        objekteCount: k.objekte.length,
      }));

      res.json(result);
    } catch (err: any) {
      console.error('[Kunde] getAll error:', err);
      res.status(500).json({ error: err.message });
    }
  },

  // ── Get single Kunde overview ──
  async getOverview(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        include: {
          person: true,
          haushalt: true,
          finanzplan: true,
          objekte: true,
          documents: { select: { id: true, type: true, originalFilename: true } },
        },
      });
      if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
      res.json(lead);
    } catch (err: any) {
      console.error('[Kunde] getOverview error:', err);
      res.status(500).json({ error: err.message });
    }
  },

  // ══════════════════════════════════════════
  // PERSON
  // ══════════════════════════════════════════
  async getPerson(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      let person = await prisma.customerPerson.findUnique({ where: { leadId } });
      if (!person) {
        // Auto-create from lead data
        const lead = await prisma.lead.findUnique({ where: { id: leadId } });
        if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
        person = await prisma.customerPerson.create({
          data: {
            leadId,
            vorname: lead.firstName,
            nachname: lead.lastName,
            email: lead.email,
            mobilnummer: lead.phone,
          },
        });
      }
      res.json(person);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  async updatePerson(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      const existing = await prisma.customerPerson.findUnique({ where: { leadId } });
      let person;
      if (existing) {
        person = await prisma.customerPerson.update({ where: { leadId }, data: req.body });
      } else {
        person = await prisma.customerPerson.create({ data: { leadId, ...req.body } });
      }
      res.json(person);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  // ══════════════════════════════════════════
  // HAUSHALT
  // ══════════════════════════════════════════
  async getHaushalt(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      let haushalt = await prisma.customerHaushalt.findUnique({ where: { leadId } });
      if (!haushalt) {
        haushalt = await prisma.customerHaushalt.create({ data: { leadId } });
      }
      res.json(haushalt);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  async updateHaushalt(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      const existing = await prisma.customerHaushalt.findUnique({ where: { leadId } });
      let haushalt;
      if (existing) {
        haushalt = await prisma.customerHaushalt.update({ where: { leadId }, data: req.body });
      } else {
        haushalt = await prisma.customerHaushalt.create({ data: { leadId, ...req.body } });
      }
      res.json(haushalt);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  // ══════════════════════════════════════════
  // FINANZPLAN
  // ══════════════════════════════════════════
  async getFinanzplan(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      let fp = await prisma.customerFinanzplan.findUnique({ where: { leadId } });
      if (!fp) {
        fp = await prisma.customerFinanzplan.create({ data: { leadId } });
      }
      res.json(fp);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  async updateFinanzplan(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      const existing = await prisma.customerFinanzplan.findUnique({ where: { leadId } });
      let fp;
      if (existing) {
        fp = await prisma.customerFinanzplan.update({ where: { leadId }, data: req.body });
      } else {
        fp = await prisma.customerFinanzplan.create({ data: { leadId, ...req.body } });
      }
      res.json(fp);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  // ══════════════════════════════════════════
  // OBJEKT (multiple per lead)
  // ══════════════════════════════════════════
  async getObjekte(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      const objekte = await prisma.customerObjekt.findMany({
        where: { leadId },
        orderBy: { createdAt: 'asc' },
      });
      res.json(objekte);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  async createObjekt(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      const objekt = await prisma.customerObjekt.create({
        data: { leadId, ...req.body },
      });
      res.json(objekt);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  async updateObjekt(req: Request, res: Response) {
    try {
      const { objektId } = req.params;
      const objekt = await prisma.customerObjekt.update({
        where: { id: objektId },
        data: req.body,
      });
      res.json(objekt);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  async deleteObjekt(req: Request, res: Response) {
    try {
      const { objektId } = req.params;
      await prisma.customerObjekt.delete({ where: { id: objektId } });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  // ══════════════════════════════════════════
  // KENNZAHLEN (DSTI, LTV, Immowert)
  // ══════════════════════════════════════════
  async getKennzahlen(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      const lead = await prisma.lead.findUnique({ where: { id: leadId } });
      if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });

      const kennzahlen = await berechneKennzahlen(leadId);
      res.json(kennzahlen);
    } catch (err: any) {
      console.error('[Kunde] getKennzahlen error:', err);
      res.status(500).json({ error: err.message });
    }
  },
};