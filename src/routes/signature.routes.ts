// src/routes/signature.routes.ts
//
// Routes für digitale Unterschrift
//
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { saveSignature, getSignatureStatus } from '../services/signature.service';

const prisma = new PrismaClient();
const router = Router();

// POST /api/signature/sign — Submit signature (authenticated)
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

// POST /api/signature/create-link — Create a public signature link token (authenticated)
router.post('/create-link', async (req: Request, res: Response) => {
  try {
    const { leadId } = req.body;
    if (!leadId) return res.status(400).json({ error: 'leadId erforderlich' });

    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) return res.status(404).json({ error: 'Lead nicht gefunden' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 Tage

    await prisma.activity.create({
      data: {
        leadId,
        type: 'WORKFLOW_TRIGGERED',
        title: 'Signatur-Link erstellt',
        description: `Link gültig bis ${expiresAt.toLocaleDateString('de-AT')}`,
        data: {
          signatureLinkToken: token,
          expiresAt: expiresAt.toISOString(),
          used: false,
        } as any,
      },
    });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const signatureUrl = `${frontendUrl}/sign/${token}`;

    console.log(`[Signature] ✅ Link created for ${lead.firstName} ${lead.lastName}: ${signatureUrl}`);

    res.json({
      success: true,
      signatureUrl,
      token,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err: any) {
    console.error('[Signature] Create link error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;

// ============================================================
// Public signature routes (no auth required)
// ============================================================
export const publicSignatureRouter = Router();

// GET /api/signature-public/verify/:token — Verify token and get lead info
publicSignatureRouter.get('/verify/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;

    const activity = await prisma.activity.findFirst({
      where: {
        type: 'WORKFLOW_TRIGGERED',
        data: { path: ['signatureLinkToken'], equals: token },
      },
      include: { lead: true },
    });

    if (!activity || !activity.lead) {
      return res.status(404).json({ error: 'Ungültiger oder abgelaufener Link' });
    }

    const data = activity.data as any;
    if (data.used) {
      return res.status(410).json({ error: 'Dieser Link wurde bereits verwendet' });
    }
    if (new Date(data.expiresAt) < new Date()) {
      return res.status(410).json({ error: 'Dieser Link ist abgelaufen' });
    }

    res.json({
      valid: true,
      leadId: activity.lead.id,
      name: `${activity.lead.firstName} ${activity.lead.lastName}`,
      email: activity.lead.email,
    });
  } catch (err: any) {
    console.error('[Signature Public] Verify error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/signature-public/sign/:token — Submit signature via public link
publicSignatureRouter.post('/sign/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { signatureBase64, signerName } = req.body;

    if (!signatureBase64 || !signerName) {
      return res.status(400).json({ error: 'signatureBase64 und signerName erforderlich' });
    }

    const activity = await prisma.activity.findFirst({
      where: {
        type: 'WORKFLOW_TRIGGERED',
        data: { path: ['signatureLinkToken'], equals: token },
      },
    });

    if (!activity) {
      return res.status(404).json({ error: 'Ungültiger Link' });
    }

    const data = activity.data as any;
    if (data.used) {
      return res.status(410).json({ error: 'Dieser Link wurde bereits verwendet' });
    }
    if (new Date(data.expiresAt) < new Date()) {
      return res.status(410).json({ error: 'Dieser Link ist abgelaufen' });
    }

    const result = await saveSignature({
      leadId: activity.leadId!,
      signatureBase64,
      signerName,
      signerRole: 'kunde',
    });

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    // Mark token as used
    await prisma.activity.update({
      where: { id: activity.id },
      data: {
        data: { ...data, used: true, signedAt: new Date().toISOString() } as any,
      },
    });

    res.json({ success: true, message: 'Unterschrift erfolgreich gespeichert' });
  } catch (err: any) {
    console.error('[Signature Public] Sign error:', err);
    res.status(500).json({ error: err.message });
  }
});
