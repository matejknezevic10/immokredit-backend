// src/routes/jeffrey-ocr.routes.ts
import { Router } from 'express';
import { processDocumentOCR, processAllDocumentsForLead } from '../services/jeffrey-ocr.service';

const router = Router();

// POST /api/jeffrey/ocr/:documentId — Process a single document
router.post('/ocr/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;
    const result = await processDocumentOCR(documentId);
    res.json({
      success: true,
      documentType: result.documentType,
      fieldsExtracted: Object.keys(result.extractedFields).length,
      sectionsUpdated: result.sectionsUpdated,
      confidence: result.confidence,
      extractedFields: result.extractedFields,
    });
  } catch (err: any) {
    console.error('[Jeffrey OCR] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jeffrey/ocr-all/:leadId — Process all pending documents for a lead
router.post('/ocr-all/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;
    const result = await processAllDocumentsForLead(leadId);
    res.json({
      success: true,
      processed: result.processed,
      results: result.results,
    });
  } catch (err: any) {
    console.error('[Jeffrey OCR] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;