// src/controllers/stellungnahme.controller.ts
import { Request, Response } from 'express';
import {
  generateStellungnahmeText,
  createStellungnahmePDF,
  uploadStellungnahmeToDrive,
} from '../services/stellungnahme.service';

export const stellungnahmeController = {
  /**
   * POST /api/stellungnahme/:leadId/generate
   * Generates the Stellungnahme text using AI. Returns { text, customerName }.
   */
  async generate(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      const result = await generateStellungnahmeText(leadId);
      res.json(result);
    } catch (err: any) {
      console.error('[Stellungnahme] generate error:', err);
      res.status(500).json({ error: err.message });
    }
  },

  /**
   * POST /api/stellungnahme/:leadId/pdf
   * Creates a PDF from the provided text and uploads to Google Drive.
   * Body: { text: string, customerName: string }
   */
  async createPDF(req: Request, res: Response) {
    try {
      const { leadId } = req.params;
      const { text, customerName } = req.body;

      if (!text || !customerName) {
        return res.status(400).json({ error: 'text und customerName sind erforderlich' });
      }

      // Create PDF
      const pdfBuffer = await createStellungnahmePDF(text, customerName);

      // Upload to Google Drive
      const { fileId, webViewLink } = await uploadStellungnahmeToDrive(
        leadId,
        pdfBuffer,
        customerName,
      );

      res.json({ success: true, fileId, webViewLink });
    } catch (err: any) {
      console.error('[Stellungnahme] createPDF error:', err);
      res.status(500).json({ error: err.message });
    }
  },

  /**
   * POST /api/stellungnahme/:leadId/preview-pdf
   * Creates a PDF preview (returns PDF as download, does NOT upload to Drive).
   * Body: { text: string, customerName: string }
   */
  async previewPDF(req: Request, res: Response) {
    try {
      const { text, customerName } = req.body;

      if (!text || !customerName) {
        return res.status(400).json({ error: 'text und customerName sind erforderlich' });
      }

      const pdfBuffer = await createStellungnahmePDF(text, customerName);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="Stellungnahme ${customerName}.pdf"`);
      res.send(pdfBuffer);
    } catch (err: any) {
      console.error('[Stellungnahme] previewPDF error:', err);
      res.status(500).json({ error: err.message });
    }
  },
};
