// src/routes/secureLink.routes.ts
//
// Routes für verschlüsselten Dokumenten-Download
//
import { Router, Request, Response } from 'express';
import { createSecureDocumentLink, validateSecureLink, getSecureLinkDocuments } from '../services/secureLink.service';
import { authMiddleware } from '../middleware/auth.middleware';
import { google } from 'googleapis';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

const router = Router();

// POST /api/secure-link/create — Generate secure download link (auth required)
router.post('/create', authMiddleware, async (req: any, res: Response) => {
  try {
    const { leadId, recipientEmail, expiresInHours } = req.body;

    if (!leadId) {
      return res.status(400).json({ error: 'leadId erforderlich' });
    }

    // Use authenticated user as sender
    const senderEmail = req.user?.email; // e.g. slaven@immo-kredit.net
    const senderName = req.user?.name;   // e.g. Slaven

    const result = await createSecureDocumentLink({
      leadId, recipientEmail, expiresInHours,
      sentBy: senderName,
      fromEmail: senderEmail,
      fromName: senderName,
    });

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

// GET /api/secure-link/download/:documentId — Proxy-download file from Google Drive (PUBLIC, token+password in query)
router.get('/download/:documentId', async (req: Request, res: Response) => {
  try {
    const { documentId } = req.params;
    const { accessToken, password } = req.query as { accessToken: string; password: string };

    if (!accessToken || !password) {
      return res.status(400).json({ error: 'accessToken und password erforderlich' });
    }

    // 1. Validate access
    // Find the activity with this access token (without incrementing counter — already counted on /validate)
    const activities = await prisma.activity.findMany({
      where: {
        type: 'WORKFLOW_TRIGGERED',
        data: { path: ['secureLinkType'], equals: 'document_download' },
      },
      orderBy: { createdAt: 'desc' },
    });

    const activity = activities.find(a => (a.data as any)?.accessToken === accessToken);
    if (!activity) return res.status(403).json({ error: 'Link ungültig' });

    const data = activity.data as any;

    // Check expiry
    if (new Date() > new Date(data.expiresAt)) {
      return res.status(403).json({ error: 'Link abgelaufen' });
    }

    // Verify password
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
    if (passwordHash !== data.passwordHash) {
      return res.status(403).json({ error: 'Falsches Passwort' });
    }

    // Check document belongs to this secure link
    const documentIds: string[] = data.documentIds || [];
    if (!documentIds.includes(documentId)) {
      return res.status(403).json({ error: 'Dokument nicht autorisiert' });
    }

    // 2. Get document from DB
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: { googleDriveId: true, originalFilename: true, mimeType: true },
    });

    if (!document?.googleDriveId) {
      return res.status(404).json({ error: 'Dokument nicht gefunden' });
    }

    // 3. Download from Google Drive and stream to client
    const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      return res.status(500).json({ error: 'Google Drive nicht konfiguriert' });
    }

    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    const drive = google.drive({ version: 'v3', auth });

    const driveRes = await drive.files.get(
      { fileId: document.googleDriveId, alt: 'media' },
      { responseType: 'stream' },
    );

    // Set headers for download
    const filename = document.originalFilename || 'download';
    res.setHeader('Content-Type', document.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

    // Pipe Google Drive stream to response
    (driveRes.data as any).pipe(res);
  } catch (err: any) {
    console.error('[SecureLink] Download proxy error:', err.message);
    res.status(500).json({ error: 'Download fehlgeschlagen' });
  }
});

export default router;
