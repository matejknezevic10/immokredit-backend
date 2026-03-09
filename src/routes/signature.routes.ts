// src/routes/signature.routes.ts
//
// Routes für digitale Unterschrift
//
import { Router, Request, Response } from 'express';
import { saveSignature, getSignatureStatus } from '../services/signature.service';

const router = Router();

// POST /api/signature/sign — Submit signature
router.post('/sign', async (req: Request, res: Response) => {
  try {
    const { leadId, signatureBase64, signerName, signerRole } = req.body;

    if (!leadId || !signatureBase64 || !signerName) {
      return res.status(400).json({
        error: 'leadId, signatureBase64 und signerName erforderlich',
      });
    }

    const result = await saveSignature({ leadId, signatureBase64, signerName, signerRole });

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    res.json({
      success: true,
      signatureId: result.signatureId,
      message: 'Unterschrift gespeichert',
    });
  } catch (err: any) {
    console.error('[Signature Route] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/signature/status/:leadId — Check signature status
router.get('/status/:leadId', async (req: Request, res: Response) => {
  try {
    const status = await getSignatureStatus(req.params.leadId);
    res.json(status);
  } catch (err: any) {
    console.error('[Signature Route] Status error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
