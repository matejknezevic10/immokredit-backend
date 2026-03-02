// src/controllers/jeffrey.controller.ts
import { Request, Response } from 'express';
import {
  checkDocuments,
  generateMissingDocsEmail,
  DOCUMENT_CHECKLIST,
} from '../services/jeffrey.service';

class JeffreyController {
  // GET /api/jeffrey/checklist
  async getChecklist(req: Request, res: Response) {
    try {
      const persoenlich = DOCUMENT_CHECKLIST.filter(i => i.category === 'PERSOENLICH');
      const immobilie = DOCUMENT_CHECKLIST.filter(i => i.category === 'IMMOBILIE');

      res.json({
        checklist: {
          persoenlicheUnterlagen: persoenlich.map(i => ({ id: i.id, label: i.label, required: i.required })),
          immobilienUnterlagen: immobilie.map(i => ({ id: i.id, label: i.label, required: i.required })),
          totalItems: DOCUMENT_CHECKLIST.length,
          totalRequired: DOCUMENT_CHECKLIST.filter(i => i.required).length,
        },
      });
    } catch (err: any) {
      console.error('[Jeffrey] Error:', err);
      res.status(500).json({ error: err.message });
    }
  }

  // GET /api/jeffrey/check/:leadId
  async checkDocs(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      const result = await checkDocuments(leadId);

      res.json({
        lead: { id: result.leadId, name: result.leadName, email: result.leadEmail },
        completion: { percent: result.completionPercent, present: result.totalPresent, required: result.totalRequired },
        present: result.present,
        missingRequired: result.missingRequired,
        missingOptional: result.missingOptional,
      });
    } catch (err: any) {
      console.error('[Jeffrey] Check error:', err);
      if (err.message === 'Lead not found') return res.status(404).json({ error: 'Lead nicht gefunden' });
      res.status(500).json({ error: err.message });
    }
  }

  // POST /api/jeffrey/remind/:leadId
  async generateReminder(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      const { check, email } = await generateMissingDocsEmail(leadId);

      res.json({
        lead: { id: check.leadId, name: check.leadName, email: check.leadEmail },
        completion: { percent: check.completionPercent, present: check.totalPresent, required: check.totalRequired },
        present: check.present,
        email: {
          to: check.leadEmail,
          subject: email.subject,
          body: email.body,
          bodyHtml: email.bodyHtml,
          missingCount: email.missingCount,
        },
        missingRequired: check.missingRequired,
        missingOptional: check.missingOptional,
      });
    } catch (err: any) {
      console.error('[Jeffrey] Remind error:', err);
      if (err.message === 'Lead not found') return res.status(404).json({ error: 'Lead nicht gefunden' });
      res.status(500).json({ error: err.message });
    }
  }
}

export const jeffreyController = new JeffreyController();