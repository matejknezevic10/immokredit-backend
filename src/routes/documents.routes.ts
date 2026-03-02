// src/routes/documents.routes.ts
import { Router } from 'express';
import multer from 'multer';
import { documentsController } from '../controllers/documents.controller';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
});

// GET /api/documents/stats (muss VOR /:id stehen!)
router.get('/stats', (req, res) => documentsController.getStats(req, res));

// GET /api/documents/types
router.get('/types', (req, res) => documentsController.getDocumentTypes(req, res));

// POST /api/documents/inbound - SendGrid Webhook
router.post('/inbound', upload.any(), (req, res) => documentsController.inboundWebhook(req, res));

// POST /api/documents/upload - Manual upload
router.post('/upload', upload.array('files', 10), (req, res) => documentsController.upload(req, res));

// POST /api/documents/n8n-upload - n8n Email attachment upload (JSON with base64)
router.post('/n8n-upload', (req, res) => documentsController.n8nUpload(req, res));

// GET /api/documents
router.get('/', (req, res) => documentsController.getAll(req, res));

// GET /api/documents/:id
router.get('/:id', (req, res) => documentsController.getById(req, res));

// PATCH /api/documents/:id/assign
router.patch('/:id/assign', (req, res) => documentsController.assign(req, res));

// PATCH /api/documents/:id/extracted-data - Edit OCR extracted data
router.patch('/:id/extracted-data', (req, res) => documentsController.updateExtractedData(req, res));

export default router;