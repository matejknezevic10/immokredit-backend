// src/services/secureLink.service.ts
//
// Verschlüsselter Dokumenten-Link + separates Passwort per Mail
//
// Workflow:
//   1. Deal erreicht Status ABGESCHLOSSEN
//   2. Backend generiert zufälliges Passwort + Zugangs-Token
//   3. Email 1: Link zum Dokumenten-Download (an Lead)
//   4. Email 2: Passwort (an Lead, separate Email)
//   5. Download-Seite: Passwort eingeben → Dokumente als ZIP herunterladen
//
// ENV: BACKEND_URL, FRONTEND_URL, SENDGRID_API_KEY
//

import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { sendTrackedEmail, EmailAttachment } from './email.service';
import { google } from 'googleapis';

const prisma = new PrismaClient();

// ============================================================
// Prisma: SecureLink wird in der gleichen DB gespeichert
// Wir nutzen ein einfaches Modell über die existing tables + JSON data
// ============================================================

// Wir speichern Secure Links als Activity mit type WORKFLOW_TRIGGERED
// und zusätzlichen JSON data. Für die Validierung brauchen wir ein eigenes Model.

// ============================================================
// Sicheren Download-Link generieren
// ============================================================
export interface CreateSecureLinkParams {
  leadId: string;
  recipientEmail?: string; // optional: custom recipient (default = lead.email)
  expiresInHours?: number; // default 72h
  sentBy?: string;
  fromEmail?: string; // sender email (from logged-in user, e.g. slaven@immo-kredit.net)
  fromName?: string;  // sender name (e.g. Slaven)
}

export interface CreateSecureLinkResult {
  success: boolean;
  accessToken?: string;
  password?: string;
  downloadUrl?: string;
  error?: string;
}

export async function createSecureDocumentLink(
  params: CreateSecureLinkParams,
): Promise<CreateSecureLinkResult> {
  const { leadId, recipientEmail, expiresInHours = 72, sentBy, fromEmail, fromName } = params;

  try {
    // 1. Load lead with documents
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      include: {
        documents: {
          where: { googleDriveId: { not: null } },
          select: {
            id: true,
            originalFilename: true,
            type: true,
            googleDriveId: true,
            googleDriveUrl: true,
          },
        },
        deal: true,
      },
    });

    if (!lead) return { success: false, error: 'Lead nicht gefunden' };
    if (lead.documents.length === 0) {
      return { success: false, error: 'Keine Dokumente zum Teilen vorhanden' };
    }

    // 2. Generate access token + password
    const accessToken = crypto.randomBytes(32).toString('hex');
    const password = generateReadablePassword();
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

    // 3. Store secure link data in Activity (with JSON data)
    await prisma.activity.create({
      data: {
        leadId,
        type: 'WORKFLOW_TRIGGERED',
        title: 'Sicherer Dokumenten-Link erstellt',
        description: `${lead.documents.length} Dokumente, gültig bis ${expiresAt.toLocaleDateString('de-AT')}`,
        data: {
          secureLinkType: 'document_download',
          accessToken,
          passwordHash,
          expiresAt: expiresAt.toISOString(),
          documentIds: lead.documents.map(d => d.id),
          accessCount: 0,
          maxAccess: 10,
          sentBy,
        },
      },
    });

    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    const downloadUrl = `${frontendUrl}/secure-download/${accessToken}`;

    // 4. Send Email 1: Download-Link
    const emailTo = recipientEmail || lead.email;
    if (!emailTo) {
      return { success: false, error: 'Keine Email-Adresse vorhanden' };
    }

    const linkEmailHtml = generateLinkEmailHtml(lead, downloadUrl, expiresAt);
    const linkResult = await sendTrackedEmail({
      leadId,
      to: emailTo,
      subject: 'ImmoKredit – Ihre Finanzierungsunterlagen',
      bodyHtml: linkEmailHtml,
      emailType: 'secure_link',
      sentBy,
      fromEmail,
      fromName,
    });

    if (linkResult.status === 'failed') {
      return { success: false, error: `Email-Versand fehlgeschlagen: ${linkResult.error || 'Unbekannter Fehler'}` };
    }

    // 5. Send Email 2: Passwort (short delay for separation)
    const passwordEmailHtml = generatePasswordEmailHtml(lead, password);
    const pwResult = await sendTrackedEmail({
      leadId,
      to: emailTo,
      subject: 'ImmoKredit – Ihr Zugangspasswort',
      bodyHtml: passwordEmailHtml,
      emailType: 'secure_password',
      sentBy,
      fromEmail,
      fromName,
    });

    if (pwResult.status === 'failed') {
      console.error(`[SecureLink] Password email failed for ${emailTo}: ${pwResult.error}`);
    }

    console.log(`[SecureLink] Created for lead ${leadId}: ${lead.documents.length} docs, expires ${expiresAt.toISOString()}`);

    return {
      success: true,
      accessToken,
      password,
      downloadUrl,
    };
  } catch (err: any) {
    console.error('[SecureLink] Error:', err);
    return { success: false, error: err.message };
  }
}

// ============================================================
// Download-Link validieren + Zugang gewähren
// ============================================================
export interface ValidateLinkResult {
  valid: boolean;
  leadName?: string;
  documentCount?: number;
  error?: string;
}

export async function validateSecureLink(
  accessToken: string,
  password: string,
): Promise<ValidateLinkResult> {
  try {
    // Find the activity with this access token
    const activities = await prisma.activity.findMany({
      where: {
        type: 'WORKFLOW_TRIGGERED',
        data: {
          path: ['secureLinkType'],
          equals: 'document_download',
        },
      },
      include: { lead: true },
      orderBy: { createdAt: 'desc' },
    });

    const activity = activities.find(a => {
      const data = a.data as any;
      return data?.accessToken === accessToken;
    });

    if (!activity) return { valid: false, error: 'Link ungültig oder abgelaufen' };

    const data = activity.data as any;

    // Check expiry
    if (new Date() > new Date(data.expiresAt)) {
      return { valid: false, error: 'Dieser Link ist abgelaufen' };
    }

    // Check max access
    if (data.accessCount >= data.maxAccess) {
      return { valid: false, error: 'Maximale Anzahl an Zugriffen erreicht' };
    }

    // Verify password
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
    if (passwordHash !== data.passwordHash) {
      return { valid: false, error: 'Falsches Passwort' };
    }

    // Increment access count
    await prisma.activity.update({
      where: { id: activity.id },
      data: {
        data: {
          ...data,
          accessCount: data.accessCount + 1,
          lastAccessAt: new Date().toISOString(),
        },
      },
    });

    return {
      valid: true,
      leadName: `${activity.lead.firstName} ${activity.lead.lastName}`,
      documentCount: data.documentIds?.length || 0,
    };
  } catch (err: any) {
    console.error('[SecureLink] Validation error:', err);
    return { valid: false, error: 'Validierungsfehler' };
  }
}

// ============================================================
// Dokumente für Download abrufen
// ============================================================
export async function getSecureLinkDocuments(accessToken: string) {
  const activities = await prisma.activity.findMany({
    where: {
      type: 'WORKFLOW_TRIGGERED',
      data: {
        path: ['secureLinkType'],
        equals: 'document_download',
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const activity = activities.find(a => (a.data as any)?.accessToken === accessToken);
  if (!activity) return [];

  const data = activity.data as any;
  const documentIds = data.documentIds || [];

  return prisma.document.findMany({
    where: { id: { in: documentIds } },
    select: {
      id: true,
      originalFilename: true,
      type: true,
      mimeType: true,
      size: true,
      googleDriveId: true,
      googleDriveUrl: true,
    },
  });
}

// ============================================================
// Dokumente als Email-Anhang an Bank/Bankberater senden
// Lädt die verarbeiteten PDFs aus Google Drive und schickt sie als Attachment
// ============================================================
export interface SendDocumentsParams {
  leadId: string;
  recipientEmail: string;
  recipientName?: string;  // z.B. "Bankberater Sparkasse"
  sentBy?: string;
  fromEmail?: string;
  fromName?: string;
}

export interface SendDocumentsResult {
  success: boolean;
  documentCount?: number;
  error?: string;
}

export async function sendDocumentsAsAttachment(
  params: SendDocumentsParams,
): Promise<SendDocumentsResult> {
  const { leadId, recipientEmail, recipientName, sentBy, fromEmail, fromName } = params;

  try {
    // 1. Load lead with documents
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      include: {
        documents: {
          where: { googleDriveId: { not: null } },
          select: {
            id: true,
            originalFilename: true,
            type: true,
            mimeType: true,
            googleDriveId: true,
          },
        },
      },
    });

    if (!lead) return { success: false, error: 'Lead nicht gefunden' };
    if (lead.documents.length === 0) {
      return { success: false, error: 'Keine Dokumente zum Senden vorhanden' };
    }

    // 2. Setup Google Drive client
    const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      return { success: false, error: 'Google Drive nicht konfiguriert' };
    }

    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    const drive = google.drive({ version: 'v3', auth });

    // 3. Download each document from Google Drive
    const attachments: EmailAttachment[] = [];
    let totalSize = 0;
    const MAX_TOTAL_SIZE = 25 * 1024 * 1024; // 25MB SendGrid limit

    for (const doc of lead.documents) {
      try {
        console.log(`[SecureLink] Downloading ${doc.originalFilename} from GDrive...`);

        // Get actual file metadata from Drive (images may have been converted to PDF)
        const fileMeta = await drive.files.get({
          fileId: doc.googleDriveId!,
          fields: 'name, mimeType',
        });
        const actualFilename = fileMeta.data.name || doc.originalFilename || `${doc.type}.pdf`;
        const actualMimeType = fileMeta.data.mimeType || doc.mimeType || 'application/pdf';

        const driveRes = await drive.files.get(
          { fileId: doc.googleDriveId!, alt: 'media' },
          { responseType: 'arraybuffer' },
        );

        const buffer = Buffer.from(driveRes.data as ArrayBuffer);
        totalSize += buffer.length;

        if (totalSize > MAX_TOTAL_SIZE) {
          console.warn(`[SecureLink] Skipping ${actualFilename}: total size exceeds 25MB`);
          continue;
        }

        attachments.push({
          content: buffer.toString('base64'),
          filename: actualFilename,
          type: actualMimeType,
        });

        console.log(`[SecureLink] Downloaded: ${actualFilename} (${(buffer.length / 1024).toFixed(0)} KB)`);
      } catch (err: any) {
        console.error(`[SecureLink] Failed to download ${doc.originalFilename}: ${err.message}`);
      }
    }

    if (attachments.length === 0) {
      return { success: false, error: 'Keine Dokumente konnten heruntergeladen werden' };
    }

    // 4. Send email with attachments
    const customerName = `${lead.firstName} ${lead.lastName}`;
    const emailHtml = generateBankEmailHtml(customerName, attachments.length, recipientName);

    const result = await sendTrackedEmail({
      leadId,
      to: recipientEmail,
      subject: `ImmoKredit – Unterlagen ${customerName}`,
      bodyHtml: emailHtml,
      emailType: 'bank_documents',
      sentBy,
      fromEmail,
      fromName,
      attachments,
    });

    if (result.status === 'failed') {
      return { success: false, error: `Email-Versand fehlgeschlagen: ${result.error}` };
    }

    // 5. Log activity
    await prisma.activity.create({
      data: {
        leadId,
        type: 'WORKFLOW_TRIGGERED',
        title: 'Unterlagen an Bank gesendet',
        description: `${attachments.length} Dokumente an ${recipientEmail} gesendet`,
      },
    });

    console.log(`[SecureLink] Sent ${attachments.length} documents to ${recipientEmail} for ${customerName}`);

    return { success: true, documentCount: attachments.length };
  } catch (err: any) {
    console.error('[SecureLink] SendDocuments error:', err);
    return { success: false, error: err.message };
  }
}

function generateBankEmailHtml(customerName: string, docCount: number, recipientName?: string): string {
  const greeting = recipientName ? `Sehr geehrte/r ${recipientName}` : 'Sehr geehrte Damen und Herren';

  return `
<div style="font-family: Arial, sans-serif; font-size: 15px; color: #333; line-height: 1.6; max-width: 600px;">
  <div style="background: linear-gradient(135deg, #1e3a5f, #2563eb); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 22px;">ImmoKredit</h1>
    <p style="color: rgba(255,255,255,0.8); margin: 5px 0 0 0; font-size: 13px;">Finanzierungsunterlagen</p>
  </div>

  <div style="padding: 30px; background: #f8fafc; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
    <p>${greeting},</p>

    <p>anbei übersende ich Ihnen die Finanzierungsunterlagen für unseren Kunden <strong>${customerName}</strong>.</p>

    <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 14px 18px; margin: 20px 0;">
      <p style="margin: 0; font-size: 14px; color: #1e40af;">
        📎 <strong>${docCount} Dokument${docCount !== 1 ? 'e' : ''}</strong> als Anhang beigefügt
      </p>
    </div>

    <p>Bei Fragen oder benötigten Ergänzungen stehe ich Ihnen jederzeit gerne zur Verfügung.</p>

    <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 25px 0;" />

    <p style="font-size: 13px; color: #64748b;">
      Mit freundlichen Grüßen<br/>
      <strong>Ihr ImmoKredit Team</strong><br/>
      +43 664 35 17 810 · info@immo-kredit.net
    </p>
  </div>
</div>`;
}

// ============================================================
// Lesbares Passwort generieren (6 Zeichen, leicht zu tippen)
// ============================================================
function generateReadablePassword(): string {
  // Vermeidet verwechselbare Zeichen (0/O, 1/l/I)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let password = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    password += chars[bytes[i] % chars.length];
  }
  return password;
}

// ============================================================
// Email Templates
// ============================================================
function generateLinkEmailHtml(lead: any, downloadUrl: string, expiresAt: Date): string {
  const firstName = lead.firstName;
  const expiryStr = expiresAt.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' });

  return `
<div style="font-family: Arial, sans-serif; font-size: 15px; color: #333; line-height: 1.6; max-width: 600px;">
  <div style="background: linear-gradient(135deg, #1e3a5f, #2563eb); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 22px;">ImmoKredit</h1>
    <p style="color: rgba(255,255,255,0.8); margin: 5px 0 0 0; font-size: 13px;">Ihre Finanzierungsunterlagen</p>
  </div>

  <div style="padding: 30px; background: #f8fafc; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
    <p>Sehr geehrte/r ${firstName},</p>

    <p>Ihre Finanzierungsunterlagen stehen für Sie zum Download bereit.</p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${downloadUrl}" style="display: inline-block; padding: 14px 36px; background: linear-gradient(135deg, #2563eb, #1d4ed8); color: white; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
        Dokumente herunterladen
      </a>
    </div>

    <div style="background: #fffbeb; border: 1px solid #fbbf24; border-radius: 8px; padding: 14px 18px; margin: 20px 0;">
      <p style="margin: 0; font-size: 13px; color: #92400e;">
        <strong>Wichtig:</strong> Das Passwort zum Entsperren erhalten Sie in einer separaten E-Mail.
      </p>
    </div>

    <p style="font-size: 13px; color: #64748b;">
      Dieser Link ist gültig bis <strong>${expiryStr}</strong>.
    </p>

    <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 25px 0;" />

    <p style="font-size: 13px; color: #64748b;">
      Bei Fragen stehen wir Ihnen jederzeit gerne zur Verfügung.<br/>
      Mit freundlichen Grüßen<br/>
      <strong>Ihr ImmoKredit Team</strong><br/>
      +43 664 35 17 810 · info@immo-kredit.net
    </p>
  </div>
</div>`;
}

function generatePasswordEmailHtml(lead: any, password: string): string {
  const firstName = lead.firstName;

  return `
<div style="font-family: Arial, sans-serif; font-size: 15px; color: #333; line-height: 1.6; max-width: 600px;">
  <div style="background: linear-gradient(135deg, #065f46, #10b981); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 22px;">ImmoKredit</h1>
    <p style="color: rgba(255,255,255,0.8); margin: 5px 0 0 0; font-size: 13px;">Ihr Zugangspasswort</p>
  </div>

  <div style="padding: 30px; background: #f8fafc; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
    <p>Sehr geehrte/r ${firstName},</p>

    <p>Hier ist Ihr Passwort für den Dokumenten-Download:</p>

    <div style="text-align: center; margin: 30px 0;">
      <div style="display: inline-block; background: #f1f5f9; border: 2px dashed #94a3b8; border-radius: 12px; padding: 20px 40px;">
        <span style="font-family: 'Courier New', monospace; font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #1e293b;">
          ${password}
        </span>
      </div>
    </div>

    <p style="font-size: 13px; color: #64748b; text-align: center;">
      Bitte geben Sie dieses Passwort auf der Download-Seite ein.<br/>
      Das Passwort ist nur zusammen mit dem Link aus der vorherigen E-Mail gültig.
    </p>

    <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 25px 0;" />

    <p style="font-size: 13px; color: #64748b;">
      Mit freundlichen Grüßen<br/>
      <strong>Ihr ImmoKredit Team</strong>
    </p>
  </div>
</div>`;
}
