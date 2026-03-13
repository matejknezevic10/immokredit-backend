// src/routes/stellungnahme.routes.ts
import { Router } from 'express';
import { stellungnahmeController } from '../controllers/stellungnahme.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// Generate Stellungnahme text via AI
router.post('/:leadId/generate', stellungnahmeController.generate);

// Create PDF and upload to Google Drive
router.post('/:leadId/pdf', stellungnahmeController.createPDF);

// Preview PDF (download, no upload)
router.post('/:leadId/preview-pdf', stellungnahmeController.previewPDF);

export default router;
