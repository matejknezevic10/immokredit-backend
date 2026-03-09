// src/routes/tracking.routes.ts
//
// Public routes for email open tracking (no auth required).
// The tracking pixel is loaded by the recipient's email client.
//
import { Router, Request, Response } from 'express';
import { TRACKING_PIXEL_PNG, recordEmailOpen } from '../services/email.service';

const router = Router();

// GET /api/tracking/pixel/:trackingId.png
// Serves a 1x1 transparent PNG and records the open event.
router.get('/pixel/:trackingId.png', async (req: Request, res: Response) => {
  const trackingId = req.params.trackingId;
  const userAgent = req.headers['user-agent'] || undefined;

  // Record the open event (fire and forget)
  recordEmailOpen(trackingId, userAgent).catch(() => {});

  // Always return the pixel (even if tracking fails)
  res.set({
    'Content-Type': 'image/png',
    'Content-Length': String(TRACKING_PIXEL_PNG.length),
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.send(TRACKING_PIXEL_PNG);
});

export default router;
