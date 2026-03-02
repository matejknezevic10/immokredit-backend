// src/routes/deals.routes.ts
import { Router } from 'express';
import { dealsController } from '../controllers/deals.controller';

const router = Router();

// GET /api/deals
router.get('/', (req, res) => dealsController.getAll(req, res));

// GET /api/deals/:id
router.get('/:id', (req, res) => dealsController.getById(req, res));

// PATCH /api/deals/:id/stage
router.patch('/:id/stage', (req, res) => dealsController.updateStage(req, res));

export default router;
