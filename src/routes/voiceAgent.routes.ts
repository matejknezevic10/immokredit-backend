// src/routes/voiceAgent.routes.ts
//
// Voice Agent Routes — Anruf starten (auth) + Webhook empfangen (public)
//
import { Router, Request, Response } from 'express';
import { initiateVoiceAgentCall, processVapiWebhook } from '../services/voiceAgent.service';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// POST /api/voice-agent/call — Initiate voice agent call (requires auth)
router.post('/call', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { leadId, phoneNumber, leadName } = req.body;

    if (!leadId || !phoneNumber) {
      return res.status(400).json({ error: 'leadId und phoneNumber erforderlich' });
    }

    const result = await initiateVoiceAgentCall({
      leadId,
      phoneNumber,
      leadName: leadName || 'Unbekannt',
    });

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    res.json({ success: true, callId: result.callId });
  } catch (err: any) {
    console.error('[VoiceAgent Route] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voice-agent/webhook — VAPI callback (public, no auth)
router.post('/webhook', async (req: Request, res: Response) => {
  try {
    await processVapiWebhook(req.body);
    res.json({ ok: true });
  } catch (err: any) {
    console.error('[VoiceAgent Webhook] Error:', err);
    res.status(200).json({ ok: true }); // Always 200 to prevent VAPI retries
  }
});

export default router;
