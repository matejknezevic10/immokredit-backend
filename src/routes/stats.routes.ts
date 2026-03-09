// src/routes/stats.routes.ts
import { Router } from 'express';
import { statsController } from '../controllers/stats.controller';

const router = Router();

// GET /api/stats
router.get('/', (req, res) => statsController.getStats(req, res));

// GET /api/stats/my-dashboard - Personalisiertes Dashboard
router.get('/my-dashboard', (req, res) => statsController.getMyDashboard(req, res));

// GET /api/stats/activities
router.get('/activities', (req, res) => statsController.getActivities(req, res));

export default router;