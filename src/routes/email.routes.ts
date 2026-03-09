// src/routes/email.routes.ts
//
// Authenticated routes for email sending and tracking history.
//
import { Router, Request, Response } from 'express';
import { sendTrackedEmail, getEmailHistory, getAllEmailHistory } from '../services/email.service';

const router = Router();

// POST /api/email/send — Send an email with tracking
router.post('/send', async (req: Request, res: Response) => {
  try {
    const { leadId, to, subject, bodyHtml, emailType, sentBy } = req.body;

    if (!leadId || !to || !subject || !bodyHtml) {
      return res.status(400).json({
        error: 'Fehlende Felder: leadId, to, subject, bodyHtml erforderlich',
      });
    }

    const result = await sendTrackedEmail({
      leadId,
      to,
      subject,
      bodyHtml,
      emailType,
      sentBy,
    });

    if (result.status === 'failed') {
      return res.status(500).json({
        error: result.error || 'Email-Versand fehlgeschlagen',
        trackingId: result.trackingId,
      });
    }

    res.json({
      success: true,
      trackingId: result.trackingId,
      message: `Email an ${to} gesendet`,
    });
  } catch (err: any) {
    console.error('[Email Route] Send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email/history — Get ALL email tracking history (for MailsPage)
router.get('/history', async (req: Request, res: Response) => {
  try {
    const allHistory = await getAllEmailHistory();
    // Flatten lead name into each entry for frontend compatibility
    const emails = allHistory.map((entry: any) => ({
      ...entry,
      leadName: entry.lead ? `${entry.lead.firstName} ${entry.lead.lastName}` : null,
      lead: undefined, // Remove nested lead object
    }));
    res.json(emails);
  } catch (err: any) {
    console.error('[Email Route] All history error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email/history/:leadId — Get email tracking history for a lead
router.get('/history/:leadId', async (req: Request, res: Response) => {
  try {
    const { leadId } = req.params;
    const history = await getEmailHistory(leadId);
    res.json(history);
  } catch (err: any) {
    console.error('[Email Route] History error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
