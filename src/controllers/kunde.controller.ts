// src/controllers/kunde.controller.ts
import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { berechneKennzahlen } from '../services/kennzahlen.service';
import { AuthRequest } from '../middleware/auth.middleware';

const prisma = new PrismaClient();

// ── Field whitelists: only these fields may be written to Prisma ──
const PERSON_FIELDS = [
  'berater', 'finanzierungsstandort', 'anrede', 'titel', 'vorname', 'nachname',
  'strasse', 'hausnummer', 'stiege', 'top', 'plz', 'ort', 'land',
  'mobilnummer', 'telefon', 'email',
  'geburtsdatum', 'geburtsland', 'geburtsort', 'alterBeiLaufzeitende',
  'anmerkungPensionsantritt',
  'staatsbuergerschaft', 'weitereStaatsbuergerschaft', 'svNummer', 'svTraeger',
  'wohnart', 'wohnhaftSeit', 'steuerdomizil',
  'familienstand', 'anzahlKinder', 'unterhaltsberechtigtePersonen',
  'hoechsteAusbildung', 'anstellungsverhaeltnis',
  'beruf', 'arbeitgeber', 'beschaeftigtSeit', 'vorbeschaeftigungsdauerMonate',
  'arbeitgeberStrasse', 'arbeitgeberHausnummer', 'arbeitgeberPlz', 'arbeitgeberOrt',
  'eigenesKfz', 'kontoverbindung', 'neuesKonto', 'neuesKontoBeiBank', 'anmerkungen',
];

const HAUSHALT_FIELDS = [
  'einkommen', 'argumentationEinkuenfte',
  'betriebskostenMiete', 'energiekosten', 'telefonInternet', 'tvGebuehren', 'anmerkungWohnkosten',
  'transportkosten', 'versicherungen', 'lebenshaltungskostenKreditbeteiligte',
  'lebenshaltungskostenKinder', 'gesonderteAusgabenKinder', 'alimente',
  'bestandskredite', 'neueVerpflichtungen',
  'summeEinnahmen', 'summeAusgaben', 'sicherheitsaufschlag', 'zwischensummeHhr',
  'freiVerfuegbaresEinkommen', 'bestandskrediteRate', 'rateFoerderung', 'zumutbareKreditrate',
  'anmerkungen',
];

const FINANZPLAN_FIELDS = [
  'finanzierungszweck', 'objektTyp',
  'kaufpreis', 'grundpreis', 'aufschliessungskosten', 'baukostenKueche',
  'renovierungskosten', 'baukostenueberschreitung', 'kaufnebenkostenProjekt', 'moebelSonstiges', 'summeProjektkosten',
  'kaufvertragTreuhandProzent', 'maklergebuehrProzent',
  'grunderwerbsteuer', 'eintragungEigentumsrecht', 'errichtungKaufvertragTreuhand', 'maklergebuehr', 'summeKaufnebenkosten',
  'eigenmittelBar', 'verkaufserloese', 'vorfinanzierung',
  'abloesekapitalVersicherung', 'bausparguthaben', 'summeEigenmittel',
  'foerderung', 'sonstigeMittel',
  'zwischenfinanzierungNetto', 'finanzierungsnebenkostenZwischen', 'zwischenfinanzierungBrutto',
  'langfrFinanzierungsbedarfNetto', 'finanzierungsnebenkosten', 'langfrFinanzierungsbedarfBrutto',
  'bearbeitungsspesen', 'kreditvermittlerprovision', 'schaetzgebuehr',
  'eintragungsgebuehrPfandrecht', 'legalisierungsgebuehren',
  'grundbucheintragung', 'grundbuchauszug', 'finanzierungsberatungshonorar',
  'zwischenKreditbetrag', 'zwischenZinssatz', 'zwischenLaufzeitMonate',
  'zwischenBearbeitungsspesen', 'zwischenAbdeckungDurch', 'zwischenSicherheiten',
  'garantieBetrag', 'garantieTermin', 'garantieLaufzeitMonate', 'garantieOriginalAn',
  'anmerkungen',
];

const OBJEKT_FIELDS = [
  'objektTyp', 'geplanteVermietung', 'zugehoerigkeitKreditnehmer',
  'katastralgemeinde', 'einlagezahl', 'grundstuecksflaeche', 'energiekennzahl', 'grundstuecksnummer',
  'strasse', 'hausnummer', 'plz', 'ort',
  'objektImBau', 'baujahr', 'baubeginn', 'bauende',
  'fertigteilbauweise', 'materialanteil',
  'treuhaenderName', 'treuhaenderTelefon', 'treuhaenderFax',
  'treuhaenderStrasse', 'treuhaenderHausnummer', 'treuhaenderPlz', 'treuhaenderOrt',
  'flaecheKeller', 'flaecheErdgeschoss', 'flaecheObergeschoss', 'flaecheWeiteresOg', 'flaecheDachgeschoss',
  'flaecheLoggia', 'flaecheBalkon', 'flaecheTerrasse', 'flaecheWintergarten', 'flaecheGarage', 'flaecheNebengebaeude',
  'sanierungAussen', 'sanierungInnen', 'orientierung',
  'ausstattungBadezimmer', 'heizung', 'ausstattungAussenbereich', 'weitereAusstattungen',
];

// Fields that are DateTime in Prisma schema — need ISO conversion
const DATETIME_FIELDS = new Set(['baubeginn', 'bauende', 'geburtsdatum']);

/** Pick only whitelisted fields from body, converting empty strings to null and fixing types */
function pickFields(body: any, allowed: string[]): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key of allowed) {
    if (key in body) {
      let val = body[key];
      // Convert empty strings to null (prevents Prisma DateTime/Float parse errors)
      if (val === '' || val === undefined) {
        val = null;
      }
      // Convert date strings to proper ISO DateTime for Prisma
      if (val && DATETIME_FIELDS.has(key)) {
        if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
          val = new Date(val + 'T00:00:00.000Z');
        } else if (typeof val === 'string') {
          val = new Date(val);
        }
        // If invalid date, set to null
        if (val instanceof Date && isNaN(val.getTime())) val = null;
      }
      result[key] = val;
    }
  }
  return result;
}

export const kundeController = {
  // ── Get all Eigenkunden des aktuellen Users ──
  async getAll(req: Request, res: Response) {
    try {
      const userId = (req as AuthRequest).user?.id;

      const kunden = await prisma.lead.findMany({
        where: {
          isKunde: true,
          assignedToId: userId,
          archivedAt: null,
          deletedAt: null,
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          ampelStatus: true,
          temperatur: true,
          createdAt: true,
          assignedAt: true,
          completionFlags: true,
          personen: { select: { id: true } },
          haushalt: { select: { id: true } },
          finanzplan: { select: { id: true } },
          objekte: { select: { id: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      const result = kunden.map(k => {
        const flags = (k as any).completionFlags as any;
        return {
          id: k.id,
          firstName: k.firstName,
          lastName: k.lastName,
          email: k.email,
          phone: k.phone,
          ampelStatus: k.ampelStatus,
          temperatur: k.temperatur,
          createdAt: k.createdAt,
          assignedAt: k.assignedAt,
          hasPersonData: flags?.person ?? (k as any).personen?.length > 0,
          hasHaushaltData: flags?.haushalt ?? !!k.haushalt,
          hasFinanzplanData: flags?.finanzplan ?? !!k.finanzplan,
          objekteCount: flags?.objekt !== undefined ? (flags.objekt ? 1 : 0) : k.objekte.length,
          completionFlags: flags || null,
        };
      });

      res.json(result);
    } catch (err: any) {
      console.error('[Kunde] getAll error:', err);
      res.status(500).json({ error: err.message });
    }
  },

  // ── Get archived Kunden ──
  async getArchived(req: Request, res: Response) {
    try {
      const userId = (req as AuthRequest).user?.id;

      const kunden = await prisma.lead.findMany({
        where: {
          isKunde: true,
          assignedToId: userId,
          archivedAt: { not: null },
          deletedAt: null,
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          temperatur: true,
          createdAt: true,
          archivedAt: true,
        },
        orderBy: { archivedAt: 'desc' },
      });

      res.json(kunden);
    } catch (err: any) {
      console.error('[Kunde] getArchived error:', err);
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
          personen: { orderBy: { personNumber: 'asc' } },
          haushalt: true,
          finanzplan: true,
          objekte: true,
          documents: { select: { id: true, type: true, originalFilename: true } },
        },
      });
      if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
      // Backward compat: also provide `person` as the first person
      const result: any = { ...lead, person: (lead as any).personen?.[0] || null };
      res.json(result);
    } catch (err: any) {
      console.error('[Kunde] getOverview error:', err);
      res.status(500).json({ error: err.message });
    }
  },

  // ══════════════════════════════════════════
  // PERSONEN (multiple per lead, up to 5)
  // ══════════════════════════════════════════

  /** GET /:leadId/personen — all persons for this lead */
  async getPersonen(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      let personen = await prisma.customerPerson.findMany({
        where: { leadId },
        orderBy: { personNumber: 'asc' },
      });

      // Auto-create first person from lead data if none exists
      if (personen.length === 0) {
        const lead = await prisma.lead.findUnique({ where: { id: leadId } });
        if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
        const first = await prisma.customerPerson.create({
          data: {
            leadId,
            personNumber: 1,
            vorname: lead.firstName,
            nachname: lead.lastName,
            email: lead.email,
            mobilnummer: lead.phone,
          },
        });
        personen = [first];
      }

      res.json(personen);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  /** GET /:leadId/person — backward compat: returns first person */
  async getPerson(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      let person = await prisma.customerPerson.findFirst({
        where: { leadId },
        orderBy: { personNumber: 'asc' },
      });
      if (!person) {
        const lead = await prisma.lead.findUnique({ where: { id: leadId } });
        if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });
        person = await prisma.customerPerson.create({
          data: {
            leadId,
            personNumber: 1,
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

  /** POST /:leadId/personen — create a new person */
  async createPerson(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      const data = pickFields(req.body, PERSON_FIELDS);

      // Find next available personNumber
      const existing = await prisma.customerPerson.findMany({
        where: { leadId },
        select: { personNumber: true },
        orderBy: { personNumber: 'desc' },
      });

      const maxNum = existing.length > 0 ? existing[0].personNumber : 0;
      if (maxNum >= 5) {
        return res.status(400).json({ error: 'Maximal 5 Kreditnehmer erlaubt' });
      }

      const person = await prisma.customerPerson.create({
        data: { leadId, personNumber: maxNum + 1, ...data },
      });

      res.json(person);
    } catch (err: any) {
      console.error('[Kunde] createPerson error:', err);
      res.status(500).json({ error: err.message });
    }
  },

  /** PUT /person/:personId — update a specific person by ID */
  async updatePerson(req: Request, res: Response) {
    try {
      const { personId } = req.params;
      const data = pickFields(req.body, PERSON_FIELDS);
      const person = await prisma.customerPerson.update({
        where: { id: personId },
        data,
      });
      res.json(person);
    } catch (err: any) {
      console.error('[Kunde] updatePerson error:', err);
      res.status(500).json({ error: err.message });
    }
  },

  /** PUT /:leadId/person — backward compat: update first person (upsert) */
  async updatePersonLegacy(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      const data = pickFields(req.body, PERSON_FIELDS);
      const existing = await prisma.customerPerson.findFirst({
        where: { leadId },
        orderBy: { personNumber: 'asc' },
      });
      let person;
      if (existing) {
        person = await prisma.customerPerson.update({ where: { id: existing.id }, data });
      } else {
        person = await prisma.customerPerson.create({ data: { leadId, personNumber: 1, ...data } });
      }
      res.json(person);
    } catch (err: any) {
      console.error('[Kunde] updatePersonLegacy error:', err);
      res.status(500).json({ error: err.message });
    }
  },

  /** DELETE /person/:personId — delete a specific person */
  async deletePerson(req: Request, res: Response) {
    try {
      const { personId } = req.params;
      // Don't allow deleting the last person (personNumber 1)
      const person = await prisma.customerPerson.findUnique({ where: { id: personId } });
      if (!person) return res.status(404).json({ error: 'Person nicht gefunden' });
      if (person.personNumber === 1) {
        return res.status(400).json({ error: 'Hauptkreditnehmer kann nicht gelöscht werden' });
      }
      await prisma.customerPerson.delete({ where: { id: personId } });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  // ══════════════════════════════════════════
  // HAUSHALT
  // ══════════════════════════════════════════

  // Helper: einkommen JSON → flache Felder für Frontend
  _flattenEinkommen(haushalt: any) {
    const result = { ...haushalt };
    if (Array.isArray(result.einkommen) && result.einkommen.length > 0) {
      const first = result.einkommen[0];
      if (first.nettoverdienst !== undefined && !result.nettoverdienst) {
        result.nettoverdienst = first.nettoverdienst;
      }
      if (first.sonstigeEinkuenfte !== undefined && !result.sonstigeEinkuenfte) {
        result.sonstigeEinkuenfte = first.sonstigeEinkuenfte;
      }
    }
    return result;
  },

  // Helper: flache Felder → einkommen JSON für DB
  _packEinkommen(body: any) {
    const data = { ...body };
    // Wenn nettoverdienst oder sonstigeEinkuenfte als flache Felder kommen → in einkommen packen
    if (data.nettoverdienst !== undefined || data.sonstigeEinkuenfte !== undefined) {
      const existing = Array.isArray(data.einkommen) ? data.einkommen : [];
      const first = existing[0] || { name: 'Kreditnehmer' };
      if (data.nettoverdienst !== undefined) {
        first.nettoverdienst = data.nettoverdienst;
        delete data.nettoverdienst;
      }
      if (data.sonstigeEinkuenfte !== undefined) {
        first.sonstigeEinkuenfte = data.sonstigeEinkuenfte;
        delete data.sonstigeEinkuenfte;
      }
      data.einkommen = [first, ...existing.slice(1)];
    }
    return data;
  },

  async getHaushalt(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      let haushalt = await prisma.customerHaushalt.findUnique({ where: { leadId } });
      if (!haushalt) {
        haushalt = await prisma.customerHaushalt.create({ data: { leadId } });
      }
      // Flatten einkommen JSON for frontend
      res.json(kundeController._flattenEinkommen(haushalt));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },

  async updateHaushalt(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      const existing = await prisma.customerHaushalt.findUnique({ where: { leadId } });
      // Pack flat fields back into einkommen JSON, then whitelist
      const packed = kundeController._packEinkommen(req.body);
      const data = pickFields(packed, HAUSHALT_FIELDS);
      let haushalt;
      if (existing) {
        haushalt = await prisma.customerHaushalt.update({ where: { leadId }, data });
      } else {
        haushalt = await prisma.customerHaushalt.create({ data: { leadId, ...data } });
      }
      res.json(kundeController._flattenEinkommen(haushalt));
    } catch (err: any) {
      console.error('[Kunde] updateHaushalt error:', err);
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
      const data = pickFields(req.body, FINANZPLAN_FIELDS);
      const existing = await prisma.customerFinanzplan.findUnique({ where: { leadId } });
      let fp;
      if (existing) {
        fp = await prisma.customerFinanzplan.update({ where: { leadId }, data });
      } else {
        fp = await prisma.customerFinanzplan.create({ data: { leadId, ...data } });
      }
      res.json(fp);
    } catch (err: any) {
      console.error('[Kunde] updateFinanzplan error:', err);
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
      const data = pickFields(req.body, OBJEKT_FIELDS);
      const objekt = await prisma.customerObjekt.create({
        data: { leadId, ...data },
      });
      res.json(objekt);
    } catch (err: any) {
      console.error('[Kunde] createObjekt error:', err);
      res.status(500).json({ error: err.message });
    }
  },

  async updateObjekt(req: Request, res: Response) {
    try {
      const { objektId } = req.params;
      const data = pickFields(req.body, OBJEKT_FIELDS);
      const objekt = await prisma.customerObjekt.update({
        where: { id: objektId },
        data,
      });
      res.json(objekt);
    } catch (err: any) {
      console.error('[Kunde] updateObjekt error:', err);
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

  // ── Toggle completion flags ──
  async updateCompletionFlags(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      const { section, value } = req.body; // section: 'person'|'haushalt'|'finanzplan'|'objekt', value: boolean

      if (!['person', 'haushalt', 'finanzplan', 'objekt'].includes(section)) {
        return res.status(400).json({ error: 'Ungültiger Abschnitt' });
      }

      const lead = await prisma.lead.findUnique({ where: { id: leadId } });
      if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });

      const currentFlags = (lead.completionFlags as any) || {};
      const updatedFlags = { ...currentFlags, [section]: value };

      await prisma.lead.update({
        where: { id: leadId },
        data: { completionFlags: updatedFlags },
      });

      res.json({ success: true, completionFlags: updatedFlags });
    } catch (err: any) {
      console.error('[Kunde] updateCompletionFlags error:', err);
      res.status(500).json({ error: err.message });
    }
  },
};