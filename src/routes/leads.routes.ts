// src/routes/leads.routes.ts
import { Router } from 'express';
import { leadsController } from '../controllers/leads.controller';
import { createCustomerFolder } from '../services/googleDrive.service';

const router = Router();

// POST /api/leads/onepage-funnel — MUST be before /:id to avoid conflict
router.post('/onepage-funnel', (req, res) => leadsController.onepageFunnel(req, res));

// GET /api/leads
router.get('/', (req, res) => leadsController.getAll(req, res));

// GET /api/leads/:id
router.get('/:id', (req, res) => leadsController.getById(req, res));

// POST /api/leads
router.post('/', (req, res) => leadsController.create(req, res));

// PATCH /api/leads/:id
router.patch('/:id', (req, res) => leadsController.update(req, res));

// DELETE /api/leads/:id
router.delete('/:id', (req, res) => leadsController.delete(req, res));

export default router;