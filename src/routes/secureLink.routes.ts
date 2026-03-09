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
    const { leadId, expiresInHours, sentBy } = req.body;

    if (!leadId) {
      return res.status(400).json({ error: 'leadId erforderlich' });
    }

    const result = await createSecureDocumentLink({ leadId, expiresInHours, sentBy });

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

// GET /api/secure-link/documents/:accessToken — Get document list (PUBLIC, no auth)
// Note: This only returns metadata, not the actual files
router.get('/documents/:accessToken', async (req: Request, res: Response) => {
  try {
    const documents = await getSecureLinkDocuments(req.params.accessToken);
    res.json(documents);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
