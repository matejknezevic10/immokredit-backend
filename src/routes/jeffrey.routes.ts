// src/routes/jeffrey.routes.ts
import { Router } from 'express';
import { jeffreyController } from '../controllers/jeffrey.controller';

const router = Router();

// GET /api/jeffrey/checklist — Full document checklist definition
router.get('/checklist', (req, res) => jeffreyController.getChecklist(req, res));

// GET /api/jeffrey/check/:leadId — Check documents for a lead
router.get('/check/:leadId', (req, res) => jeffreyController.checkDocs(req, res));

// POST /api/jeffrey/remind/:leadId — Generate reminder email for missing docs
router.post('/remind/:leadId', (req, res) => jeffreyController.generateReminder(req, res));

export default router;