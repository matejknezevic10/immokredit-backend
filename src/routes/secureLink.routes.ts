// src/routes/secureLink.routes.ts
//
// Routes für verschlüsselten Dokumenten-Download
//
import { Router, Request, Response } from 'express';
import { createSecureDocumentLink, validateSecureLink, getSecureLinkDocuments } from '../services/secureLink.service';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// POST /api/secure-link/create — Generate secure download link (auth required)
router.post('/create', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { leadId, recipientEmail, expiresInHours, sentBy } = req.body;

    if (!leadId) {
      return res.status(400).json({ error: 'leadId erforderlich' });
    }

    const result = await createSecureDocumentLink({ leadId, recipientEmail, expiresInHours, sentBy });

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    res.json({
      success: true,
      downloadUrl: result.downloadUrl,
      password: result.password,
      message: 'Link und Passwort per Email gesendet',
    });
  } catch (err: any) {
    console.error('[SecureLink Route] Create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/secure-link/validate — Validate token + password (PUBLIC, no auth)
router.post('/validate', async (req: Request, res: Response) => {
  try {
    const { accessToken, password } = req.body;

    if (!accessToken || !password) {
      return res.status(400).json({ valid: false, error: 'accessToken und password erforderlich' });
    }

    const result = await validateSecureLink(accessToken, password);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ valid: false, error: err.message });
  }
});

// POST /api/secure-link/documents — Get document list (requires accessToken + password)
// Changed from GET to POST: password must be verified before exposing document metadata
router.post('/documents', async (req: Request, res: Response) => {
  try {
    const { accessToken, password } = req.body;
    if (!accessToken || !password) {
      return res.status(400).json({ error: 'accessToken und password erforderlich' });
    }

    // Validate password BEFORE returning documents
    const validation = await validateSecureLink(accessToken, password);
    if (!validation.valid) {
      return res.status(403).json({ error: validation.error || 'Zugang verweigert' });
    }

    const documents = await getSecureLinkDocuments(accessToken);
    res.json(documents);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
