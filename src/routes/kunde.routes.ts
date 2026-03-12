// src/routes/kunde.routes.ts
import { Router } from 'express';
import { kundeController } from '../controllers/kunde.controller';

const router = Router();

// Kunden-Liste
router.get('/', kundeController.getAll);

// Archivierte Kunden — MUST be before /:leadId
router.get('/archiv', kundeController.getArchived);

// Kunde Overview (alle 4 Sparten)
router.get('/:leadId', kundeController.getOverview);

// Personen (multiple, up to 5)
router.get('/:leadId/personen', kundeController.getPersonen);
router.post('/:leadId/personen', kundeController.createPerson);
router.put('/person/:personId', kundeController.updatePerson);
router.delete('/person/:personId', kundeController.deletePerson);

// Backward compat: single person endpoints
router.get('/:leadId/person', kundeController.getPerson);
router.put('/:leadId/person', kundeController.updatePersonLegacy);

// Haushalt
router.get('/:leadId/haushalt', kundeController.getHaushalt);
router.put('/:leadId/haushalt', kundeController.updateHaushalt);

// Finanzplan
router.get('/:leadId/finanzplan', kundeController.getFinanzplan);
router.put('/:leadId/finanzplan', kundeController.updateFinanzplan);

// Kennzahlen (DSTI, LTV, Immowert)
router.get('/:leadId/kennzahlen', kundeController.getKennzahlen);

// Pflichtfelder-Check
router.get('/:leadId/pflichtfelder', kundeController.getPflichtfelder);

// Objekt (multiple)
router.get('/:leadId/objekte', kundeController.getObjekte);
router.post('/:leadId/objekte', kundeController.createObjekt);
router.put('/objekt/:objektId', kundeController.updateObjekt);
router.delete('/objekt/:objektId', kundeController.deleteObjekt);

// Completion flags (manual override)
router.patch('/:leadId/completion', kundeController.updateCompletionFlags);

export default router;