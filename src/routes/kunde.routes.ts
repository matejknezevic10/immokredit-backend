// src/routes/kunde.routes.ts
import { Router } from 'express';
import { kundeController } from '../controllers/kunde.controller';

const router = Router();

// Kunden-Liste
router.get('/', kundeController.getAll);

// Kunde Overview (alle 4 Sparten)
router.get('/:leadId', kundeController.getOverview);

// Person
router.get('/:leadId/person', kundeController.getPerson);
router.put('/:leadId/person', kundeController.updatePerson);

// Haushalt
router.get('/:leadId/haushalt', kundeController.getHaushalt);
router.put('/:leadId/haushalt', kundeController.updateHaushalt);

// Finanzplan
router.get('/:leadId/finanzplan', kundeController.getFinanzplan);
router.put('/:leadId/finanzplan', kundeController.updateFinanzplan);

// Objekt (multiple)
router.get('/:leadId/objekte', kundeController.getObjekte);
router.post('/:leadId/objekte', kundeController.createObjekt);
router.put('/objekt/:objektId', kundeController.updateObjekt);
router.delete('/objekt/:objektId', kundeController.deleteObjekt);

export default router;