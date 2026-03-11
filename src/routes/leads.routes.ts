// src/routes/leads.routes.ts
import { Router } from 'express';
import { leadsController } from '../controllers/leads.controller';
import { createCustomerFolder } from '../services/googleDrive.service';

const router = Router();

// POST /api/leads/onepage-funnel — MUST be before /:id to avoid conflict
router.post('/onepage-funnel', (req, res) => leadsController.onepageFunnel(req, res));

// POST /api/leads/:id/convert-to-eigenkunde — MUST be before /:id to avoid conflict
router.post('/:id/convert-to-eigenkunde', (req, res) => leadsController.convertToEigenkunde(req, res));

// POST /api/leads/:id/archive
router.post('/:id/archive', (req, res) => leadsController.archive(req, res));

// POST /api/leads/:id/unarchive
router.post('/:id/unarchive', (req, res) => leadsController.unarchive(req, res));

// POST /api/leads/:id/abschluss
router.post('/:id/abschluss', (req, res) => leadsController.abschluss(req, res));

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