// src/services/email.service.ts
//
// Email Sending + Open-Tracking Service
// Sendet Emails via SendGrid und bettet ein Tracking-Pixel ein.
//
// Benötigte ENV Variablen:
//   SENDGRID_API_KEY       - SendGrid API Key für Email-Versand
//   SENDGRID_FROM_EMAIL    - Absender-Email (default: info@immo-kredit.net)
//   SENDGRID_FROM_NAME     - Absender-Name (default: ImmoKredit)
//   BACKEND_URL            - Öffentliche Backend URL für Tracking-Pixel
//

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ============================================================
// SendGrid Setup (lazy loaded)
// ============================================================
let sgMail: any = null;

function getSendGrid() {
  if (!sgMail) {
    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) {
      throw new Error('SENDGRID_API_KEY nicht konfiguriert. Email-Versand nicht möglich.');
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(apiKey);
  }
  return sgMail;
}

// ============================================================
// 1x1 Transparent PNG (68 bytes)
// ============================================================
export const TRACKING_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// ============================================================
// Tracking Pixel in HTML einbetten
// ============================================================
function injectTrackingPixel(html: string, trackingId: string): string {
  const backendUrl = (process.env.BACKEND_URL || 'http://localhost:4000').replace(/\/$/, '');
  const pixelUrl = `${backendUrl}/api/tracking/pixel/${trackingId}.png`;
  const pixelTag = `<img src="${pixelUrl}" width="1" height="1" style="display:none;border:0;width:1px;height:1px;" alt="" />`;

  // Insert before closing </div> or append at end
  if (html.includes('</div>')) {
    const lastDiv = html.lastIndexOf('</div>');
    return html.slice(0, lastDiv) + pixelTag + html.slice(lastDiv);
  }
  return html + pixelTag;
}

// ============================================================
// Email senden mit Tracking
// ============================================================
export interface SendEmailParams {
  leadId: string;
  to: string;
  subject: string;
  bodyHtml: string;
  emailType?: string;  // reminder, notification, custom
  sentBy?: string;     // User name
}

export interface SendEmailResult {
  trackingId: string;
  status: 'sent' | 'failed';
  error?: string;
}

export async function sendTrackedEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const { leadId, to, subject, bodyHtml, emailType = 'reminder', sentBy } = params;

  // 1. Create tracking record first (to get ID for pixel)
  const tracking = await prisma.emailTracking.create({
    data: {
      leadId,
      to,
      subject,
      bodyHtml,
      emailType,
      sentBy,
      status: 'sent',
    },
  });

  // 2. Inject tracking pixel into HTML
  const htmlWithPixel = injectTrackingPixel(bodyHtml, tracking.id);

  // 3. Send via SendGrid
  try {
    const sg = getSendGrid();
    const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'info@immo-kredit.net';
    const fromName = process.env.SENDGRID_FROM_NAME || 'ImmoKredit';

    const [response] = await sg.send({
      to,
      from: { email: fromEmail, name: fromName },
      subject,
      html: htmlWithPixel,
    });

    // Store SendGrid message ID
    const messageId = response?.headers?.['x-message-id'] || null;
    if (messageId) {
      await prisma.emailTracking.update({
        where: { id: tracking.id },
        data: { sendgridMessageId: messageId },
      });
    }

    // Log activity
    await prisma.activity.create({
      data: {
        leadId,
        type: 'EMAIL_SENT',
        title: `Email gesendet: ${subject}`,
        description: `An: ${to}`,
        data: { trackingId: tracking.id, emailType },
      },
    });

    console.log(`[Email] Sent to ${to}: "${subject}" (tracking: ${tracking.id})`);
    return { trackingId: tracking.id, status: 'sent' };
  } catch (err: any) {
    console.error(`[Email] Send failed:`, err.message);

    // Update tracking status
    await prisma.emailTracking.update({
      where: { id: tracking.id },
      data: { status: 'failed' },
    });

    return { trackingId: tracking.id, status: 'failed', error: err.message };
  }
}

// ============================================================
// Tracking Pixel geöffnet — loggt den Open-Event
// ============================================================
export async function recordEmailOpen(
  trackingId: string,
  userAgent?: string,
): Promise<boolean> {
  try {
    const tracking = await prisma.emailTracking.findUnique({
      where: { id: trackingId },
    });

    if (!tracking) {
      console.log(`[Tracking] Unknown tracking ID: ${trackingId}`);
      return false;
    }

    const now = new Date();
    const isFirstOpen = !tracking.openedAt;

    await prisma.emailTracking.update({
      where: { id: trackingId },
      data: {
        openCount: { increment: 1 },
        lastOpenedAt: now,
        status: 'opened',
        // Only set openedAt and userAgent on first open
        ...(isFirstOpen && {
          openedAt: now,
          userAgent: userAgent?.substring(0, 500) || null,
        }),
      },
    });

    if (isFirstOpen) {
      console.log(`[Tracking] First open: ${tracking.subject} (${tracking.to})`);

      // Create activity for first open
      await prisma.activity.create({
        data: {
          leadId: tracking.leadId,
          type: 'EMAIL_SENT', // Reuse EMAIL_SENT type, distinguish via title
          title: `Email geöffnet: ${tracking.subject}`,
          description: `${tracking.to} hat die Email geöffnet`,
          data: { trackingId, event: 'opened' },
        },
      });
    }

    return true;
  } catch (err: any) {
    console.error(`[Tracking] Error recording open:`, err.message);
    return false;
  }
}

// ============================================================
// Email-Verlauf für einen Lead abrufen
// ============================================================
export async function getEmailHistory(leadId: string) {
  return prisma.emailTracking.findMany({
    where: { leadId },
    orderBy: { sentAt: 'desc' },
    select: {
      id: true,
      to: true,
      subject: true,
      emailType: true,
      sentBy: true,
      sentAt: true,
      status: true,
      openedAt: true,
      openCount: true,
      lastOpenedAt: true,
    },
  });
}

// ============================================================
// Gesamter Email-Verlauf (alle Leads) — für MailsPage
// ============================================================
export async function getAllEmailHistory() {
  return prisma.emailTracking.findMany({
    orderBy: { sentAt: 'desc' },
    select: {
      id: true,
      to: true,
      subject: true,
      emailType: true,
      sentBy: true,
      sentAt: true,
      status: true,
      openedAt: true,
      openCount: true,
      lastOpenedAt: true,
      leadId: true,
      lead: {
        select: {
          firstName: true,
          lastName: true,
        },
      },
    },
  });
}
